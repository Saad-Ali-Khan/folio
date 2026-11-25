import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import type { Database } from "../lib/db";
import { POST } from "../app/api/discord/inventory/photo/route";
import { startOcrServer } from "./ocr/server";

async function main() {
  const originalRoot = process.cwd(), nativeFetch = globalThis.fetch;
  const folder = mkdtempSync(path.join(originalRoot, ".folio-local-test-"));
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  const globals = globalThis as typeof globalThis & { folioDb?: Promise<Database>; folioCoverMatches?: Map<string, unknown> };
  const priorDb = globals.folioDb;
  const values = { INVENTORY_DISCORD_SECRET: "test-secret", INVENTORY_DISCORD_PIN: "test-pin", DISCORD_CHANNEL_ID: "inventory",
    DISCORD_PHOTO_USER_IDS: "owner", FOLIO_OCR_ENGINE: "paddle", PHOTO_STORAGE: "inline" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  let catalogOffline = false, scans = 0;
  const server = await startOcrServer({ ready: true, modelLoads: 1, stop() {}, call: async () => {
    scans++; return { lines: [{ text: "Test Book", height: .1, top: .2, left: .1, confidence: 99 },
      { text: "Test Author", height: .1, top: .7, left: .1, confidence: 99 }] };
  } }, path.join(folder, ".folio-local/ocr.json"));
  try {
    await applyMigrations(db, readdirSync("drizzle").filter(file => file.endsWith(".sql")).sort()
      .map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") })));
    globals.folioDb = Promise.resolve(db);
    Object.assign(process.env, values);
    process.chdir(folder);
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "127.0.0.1" && url.port === String(server.port)) return nativeFetch(input, init);
      if (url.hostname === "openlibrary.org") return catalogOffline ? new Response(null, { status: 503 }) : Response.json({ docs: [{
        key: "/works/OL999W", title: "Test Book", author_name: ["Test Author"], editions: { docs: [{ title: "Test Book", language: ["eng"] }] },
      }] });
      return Response.json({ results: [] });
    };
    const image = new Uint8Array(await sharp({ create: { width: 40, height: 60, channels: 3, background: "white" } }).png().toBuffer());
    const upload = (id: string) => POST(new Request("http://localhost/api/discord/inventory/photo", {
      method: "POST", headers: { "content-type": "image/png", "x-inventory-secret": "test-secret", "x-channel-id": "inventory",
        "x-message-id": id, "x-user-id": "owner" }, body: image,
    }));
    const first = await upload("mobile-first"); assert.equal(first.status, 200);
    assert.match((await first.json()).reply, /Received 1 copy of Test Book/);
    const stock = async () => (await db.select().from(schema.books).where(eq(schema.books.isbn, "manual-cover-ol999w")))[0]?.stock;
    assert.equal(await stock(), 1);
    await upload("mobile-first"); assert.equal(await stock(), 1); assert.equal(scans, 1, "duplicate message stops before OCR");
    await upload("mobile-second"); assert.equal(await stock(), 2);
    assert.equal((await db.select().from(schema.bookPhotos)).length, 1, "duplicate image retains one listing photo");
    globals.folioCoverMatches?.clear(); catalogOffline = true;
    const failed = await upload("mobile-outage");
    assert.match((await failed.json()).reply, /catalog didn.t respond/);
    assert.equal(await stock(), 2, "catalog outage cannot add stock");
    console.log("PASS mobile HTTP worker -> authenticated import -> persisted draft/photo, duplicate protection and outage without stock changes. Isolated database only; no Discord messages.");
  } finally {
    process.chdir(originalRoot); globalThis.fetch = nativeFetch; globals.folioDb = priorDb; globals.folioCoverMatches?.clear();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await server.stop(); await client.close(); rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
