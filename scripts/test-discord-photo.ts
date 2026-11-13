import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import bwip from "bwip-js/node";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { POST as handlePhoto } from "../app/api/discord/inventory/photo/route";
import { POST as handleCommand } from "../app/api/discord/inventory/route";
import type { Database } from "../lib/db";
import { applyMigrations } from "../lib/db/migrations";
import { lookupIsbnMetadata } from "../lib/import-metadata";
import * as schema from "../lib/db/schema";

async function main() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  const globals = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
  globals.folioDb = Promise.resolve(db);
  const fetchBeforeTest = globalThis.fetch;
  try {
    await applyMigrations(db, readdirSync("drizzle").filter(file => file.endsWith(".sql")).sort()
      .map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") })));
    process.env.INVENTORY_DISCORD_SECRET = "test-bot-secret";
    process.env.INVENTORY_DISCORD_PIN = "test-pin";
    process.env.DISCORD_CHANNEL_ID = "inventory";
    delete process.env.DISCORD_PHOTO_USER_IDS;

    const isbn = "9780141037455";
    const image = new Uint8Array(await bwip.toBuffer({ bcid: "ean13", text: isbn, scale: 2, paddingwidth: 15 }));
    let coverLookupFailures = 2;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "openlibrary.org");
      const english = url.searchParams.has("q");
      const doc = {
        key: "/works/OL123W",
        title: "El amor en los tiempos del cólera",
        author_name: ["Gabriel García Márquez"],
        edition_count: 100,
        editions: { docs: [{ title: english ? "Love in the Time of Cholera" : "El amor en los tiempos del cólera", language: [english ? "eng" : "spa"] }] },
      };
      const coverSearch = url.searchParams.get("q")?.startsWith("title:");
      if (coverSearch && coverLookupFailures > 0) {
        coverLookupFailures -= 1;
        return new Response(null, { status: 503 });
      }
      const bilingual = { ...doc, editions: { docs: [{ title: "El amor en los tiempos del cólera / Love in the Time of Cholera", language: ["spa", "eng"] }] } };
      return Response.json({ docs: coverSearch ? [bilingual, { ...doc, key: "/works/OL456W", title: "Love in the Time of Cholera", edition_count: 1 }] : [doc] });
    };

    async function upload(messageId: string, userId: string, caption = "", bytes = image) {
      const response = await handlePhoto(new Request("http://localhost/api/discord/inventory/photo", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-inventory-secret": "test-bot-secret",
          "x-channel-id": "inventory",
          "x-message-id": messageId,
          "x-user-id": userId,
          "x-guild-owner-id": "owner",
          "x-command-text": caption,
        },
        body: bytes,
      }));
      assert.equal(response.status, 200);
      return await response.json();
    }

    assert.match((await upload("other-photo", "other")).reply, /not enabled/);
    const prompt = await upload("new-photo", "owner");
    assert.match(prompt.reply, /Choose the display title/);
    assert.match(prompt.titleChoiceId, /^[0-9a-f]{10}$/);
    assert.equal((await db.select().from(schema.books)).length, 0);

    async function click(userId: string, secret = "test-bot-secret", choiceId = prompt.titleChoiceId) {
      return await handleCommand(new Request("http://localhost/api/discord/inventory", {
        method: "POST",
        headers: { "content-type": "application/json", "x-inventory-secret": secret },
        body: JSON.stringify({ messageId: "click", channelId: "inventory", userId, titleChoice: { id: choiceId, selection: "ENGLISH" } }),
      }));
    }
    assert.equal((await click("owner", "wrong-secret")).status, 401);
    assert.match((await (await click("other")).json()).reply, /not found/);
    assert.match((await (await click("owner")).json()).reply, /Received 1 copy/);
    assert.match((await (await click("owner")).json()).reply, /already handled/);
    const stock = async () => (await db.select().from(schema.books).where(eq(schema.books.isbn, isbn)))[0].stock;
    assert.equal(await stock(), 1);
    await upload("new-photo", "owner");
    assert.equal(await stock(), 1);
    await upload("another-photo", "owner");
    await upload("another-photo", "owner");
    assert.equal(await stock(), 2);
    await upload("caption-photo", "other", "test-pin SET 5");
    assert.equal(await stock(), 5);

    const cover = new Uint8Array(await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
        <rect width="800" height="1000" fill="#fff9e8"/>
        <text x="400" y="345" text-anchor="middle" font-family="Arial" font-size="74" font-weight="bold">LOVE IN THE</text>
        <text x="400" y="440" text-anchor="middle" font-family="Arial" font-size="68" font-weight="bold">TIME OF CHOLERA</text>
        <text x="400" y="720" text-anchor="middle" font-family="Arial" font-size="41">GABRIEL GARCIA MARQUEZ</text>
      </svg>`)).png().toBuffer());
    const coverPrompt = await upload("cover-photo", "owner", "", cover);
    assert.equal(coverLookupFailures, 0);
    assert.match(coverPrompt.titleChoiceId, /^[0-9a-f]{10}$/);
    assert.match(coverPrompt.reply, /English: Love in the Time of Cholera\nOriginal\/catalog: El amor en los tiempos del cólera/);
    assert.match((await (await click("owner", "test-bot-secret", coverPrompt.titleChoiceId)).json()).reply, /Received 1 copy/);
    await upload("cover-repeat", "owner", "", cover);
    await upload("cover-repeat", "owner", "", cover);
    const [coverDraft] = await db.select().from(schema.books).where(eq(schema.books.isbn, "manual-cover-ol123w"));
    assert.equal(coverDraft.stock, 2);
    assert.equal(coverDraft.status, "draft");
    assert.equal(await stock(), 5, "front-cover imports never increment a verified ISBN edition");

    process.env.DISCORD_PHOTO_USER_IDS = "other";
    assert.match((await upload("excluded-owner", "owner")).reply, /not enabled/);
    const unknown = "9780441172719";
    const unknownImage = new Uint8Array(await bwip.toBuffer({ bcid: "ean13", text: unknown, scale: 2, paddingwidth: 15 }));
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.match((await upload("offline-lookup", "other", "", unknownImage)).reply, /ISBN-only draft/);
    const [draft] = await db.select().from(schema.books).where(eq(schema.books.isbn, unknown));
    assert.equal(draft.stock, 1);
    assert.equal(draft.status, "draft");
    assert.equal(draft.author, "Unknown author");
    const regionalIsbn = "9789696400837";
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname === "/search.json") return Response.json({ docs: [] });
      assert.equal(url.pathname, "/api/books");
      assert.equal(url.searchParams.get("bibkeys"), `ISBN:${regionalIsbn}`);
      return Response.json({ [`ISBN:${regionalIsbn}`]: { title: "The Little Prince", authors: [{ name: "Antoine de Saint-Exupéry" }] } });
    };
    const fallback = await lookupIsbnMetadata(regionalIsbn);
    assert.equal(fallback.status, "found");
    if (fallback.status === "found") {
      assert.equal(fallback.metadata.isbn, regionalIsbn);
      assert.equal(fallback.metadata.author, "Antoine de Saint-Exupéry");
    }
    const regionalImage = new Uint8Array(await bwip.toBuffer({ bcid: "ean13", text: regionalIsbn, scale: 2, paddingwidth: 15 }));
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "openlibrary.org");
      return url.pathname === "/search.json" ? Response.json({ docs: [] }) : Response.json({});
    };
    assert.match((await upload("regional-isbn", "other", "", regionalImage)).reply, /The Little Prince.*British Council/);
    const [regionalDraft] = await db.select().from(schema.books).where(eq(schema.books.isbn, regionalIsbn));
    assert.equal(regionalDraft.author, "Antoine de Saint-Exupéry");
    assert.equal(regionalDraft.status, "draft");

    const hathiIsbn = "9780030110405";
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname === "/search.json") return Response.json({ docs: [] });
      if (url.pathname === "/api/books") return Response.json({});
      const records = {
        unrelated: { isbns: ["9780141037455"], titles: ["Wrong edition"] },
        ...(url.pathname.endsWith(`/${hathiIsbn}.json`) ? {
          matching: {
            isbns: ["0-03-011040-8"],
            titles: ["Infinite series"],
            "marc-xml": '<datafield tag="100"><subfield code="a">Hirschman, I. I.</subfield></datafield>',
          },
        } : {}),
      };
      return Response.json({ records });
    };
    const hathi = await lookupIsbnMetadata(hathiIsbn);
    assert.equal(hathi.status, "found");
    if (hathi.status === "found") {
      assert.equal(hathi.metadata.title, "Infinite series");
      assert.equal(hathi.metadata.author, "I. I. Hirschman");
      assert.equal(hathi.metadata.isbn, hathiIsbn);
    }
    assert.equal((await lookupIsbnMetadata(unknown)).status, "missing");
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.equal((await lookupIsbnMetadata(unknown)).status, "unavailable");
    console.log("Passed photo imports, title choices, edition isolation, duplicate protection, and ISBN catalogue fallbacks");
  } finally {
    globalThis.fetch = fetchBeforeTest;
    delete globals.folioDb;
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
