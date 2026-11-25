import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import bwip from "bwip-js/node";
import sharp from "sharp";
import * as schema from "../lib/db/schema";
import { type Database, findBooksByIdentifier, findBooksByIsbn } from "../lib/db";
import { updateAdminBook } from "../lib/admin-books";
import { getEdition } from "../lib/book-editions";
import { importDiscordBook } from "../lib/discord-inventory";
import { reserveCheckout, releaseCheckout } from "../lib/order-service";
import { POST as photo } from "../app/api/discord/inventory/photo/route";
import { POST as command } from "../app/api/discord/inventory/route";

async function main() {
  const engine = new PGlite(), db = drizzle(engine, { schema }) as unknown as Database;
  const globals = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
  const previousDb = globals.folioDb, previousFetch = globalThis.fetch;
  const env = { INVENTORY_DISCORD_SECRET: "test-secret", INVENTORY_DISCORD_PIN: "test-pin", DISCORD_CHANNEL_ID: "inventory", DISCORD_PHOTO_USER_IDS: "owner" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    for (const name of readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) await engine.exec(readFileSync(`drizzle/${name}`, "utf8"));
    globals.folioDb = Promise.resolve(db); Object.assign(process.env, env);
    globalThis.fetch = async () => { throw Error("External requests disabled in isolated test"); };
    const isbn = "9780805210552";
    const [a] = await db.insert(schema.books).values({ isbn, slug: "copy-a", title: "The Complete Stories", author: "Franz Kafka", description: "Clean copy", priceCents: 10000, stock: 2, status: "published" }).returning();
    const [b] = await db.insert(schema.books).values({ isbn: "manual-second", slug: "copy-b", title: a.title, author: a.author, description: "Annotated copy", priceCents: 0, stock: 0 }).returning();
    const saved = await updateAdminBook(db, { ...b, price: "0", expected: b, editionDetails: { publisher: "Test publisher", translator: "", language: "English", edition: "Copy B", evidence: "", reviewed: false,
      expectedRevision: 0, expectedIsbn: b.isbn, linkIsbn: isbn, isbnConfirmed: true, isbnEvidence: "Synthetic physical-copy confirmation", candidateId: "", useArtwork: false } });
    assert.equal(saved.id, b.id); assert.equal(saved.stock, 0); assert.equal(saved.isbn, a.isbn);
    const stock = async (id: number) => (await db.select().from(schema.books).where(eq(schema.books.id, id)))[0].stock;
    assert.equal(await stock(a.id), 2); assert.equal((await getEdition(db, a.id)).publisher, "");
    assert.equal((await getEdition(db, b.id)).edition, "Copy B");
    for (const row of [a, b]) await db.insert(schema.bookPhotos).values({ bookId: row.id,
      data: (await sharp({ create: { width: 10, height: 14, channels: 3, background: row.id === a.id ? "red" : "blue" } }).webp().toBuffer()).toString("base64") });
    assert.notEqual((await db.select().from(schema.bookPhotos))[0].data, (await db.select().from(schema.bookPhotos))[1].data);
    assert.equal((await findBooksByIdentifier(db, isbn)).length, 2);
    assert.equal((await findBooksByIsbn(db, "0805210555")).length, 2, "ISBN-10 aliases return every matching listing");
    assert.equal((await findBooksByIdentifier(db, `id:${b.id}`))[0].id, b.id);
    assert.equal((await findBooksByIdentifier(db, "slug:copy-a"))[0].id, a.id);
    await assert.rejects(importDiscordBook(db, "ambiguous-import", "inventory", { title: a.title, author: a.author, isbn, coverUrl: null }, 1), /Multiple listings/);
    assert.equal((await db.select().from(schema.discordCommands)).length, 0, "ambiguous import rolls back its claim");
    const send = async (id: string, text: string) => (await command(new Request("http://localhost/api/discord/inventory", { method: "POST",
      headers: { "content-type": "application/json", "x-inventory-secret": "test-secret" }, body: JSON.stringify({ messageId: id, userId: "owner", channelId: "inventory", text: `test-pin ${text}` }) }))).json();
    await send("target-b", `ADD id:${b.id} 2`); assert.equal(await stock(a.id), 2); assert.equal(await stock(b.id), 2);
    const image = new Uint8Array(await bwip.toBuffer({ bcid: "ean13", text: isbn, scale: 2, paddingwidth: 15 }));
    const scan = (id: string) => photo(new Request("http://localhost/api/discord/inventory/photo", { method: "POST",
      headers: { "content-type": "image/png", "x-inventory-secret": "test-secret", "x-channel-id": "inventory", "x-message-id": id, "x-user-id": "owner" }, body: image }));
    const prompt = await (await scan("shared-barcode")).json(); assert.match(prompt.reply, /Which book/);
    assert.match(prompt.reply, new RegExp(`#${a.id}`)); assert.match(prompt.reply, new RegExp(`#${b.id}`));
    assert.equal(await stock(a.id), 2); assert.equal(await stock(b.id), 2);
    const [choice] = await db.select().from(schema.discordStockChoices).where(eq(schema.discordStockChoices.sourceMessageId, "shared-barcode"));
    await send("choose-b", `CONFIRM ${choice.id} 2`); await send("choose-b-again", `CONFIRM ${choice.id} 2`);
    assert.equal(await stock(a.id), 2); assert.equal(await stock(b.id), 3);
    console.log("PASS shared ISBN/ISBN-10 lookup, independent photos/details, exact listing commands and barcode confirmation without double stock");
    const [current] = await db.select().from(schema.books).where(eq(schema.books.id, b.id));
    await updateAdminBook(db, { ...current, expected: current, price: "250", stock: current.stock, status: "published" });
    const held = await reserveCheckout(db, [{ id: a.id, qty: 1 }, { id: b.id, qty: 2 }], "http://localhost:3000");
    assert.deepEqual(held.lines.map(line => [line.bookId, line.priceCents]), [[a.id, 10000], [b.id, 25000]]);
    assert.equal(await stock(a.id), 1); assert.equal(await stock(b.id), 1);
    await releaseCheckout(db, held.id); assert.equal(await stock(a.id), 2); assert.equal(await stock(b.id), 3);
    await db.insert(schema.pendingCovers).values({ id: "a".repeat(20), sourceMessageId: "retained", userId: "owner", channelId: "inventory", qty: 1,
      objectKey: "pending/test/object", state: "waiting", expiresAt: new Date(Date.now() + 60000) });
    assert.match((await (await scan("shared-with-cover")).json()).reply, /haven.t added stock or attached/);
    assert.equal(await stock(a.id), 2); assert.equal(await stock(b.id), 3);
    await assert.rejects(db.insert(schema.books).values({ isbn: "manual-stable", slug: "manual-1", title: "Manual", author: "Author", priceCents: 0 })
      .then(() => db.insert(schema.books).values({ isbn: "manual-stable", slug: "manual-2", title: "Manual", author: "Author", priceCents: 0 })));
    console.log("PASS shared-ISBN checkout reserves/releases separate prices and quantities; ambiguous retained-cover scan changes nothing; manual import keys stay unique. No production, orders, messages or external services touched.");
  } finally {
    globals.folioDb = previousDb; globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await engine.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
