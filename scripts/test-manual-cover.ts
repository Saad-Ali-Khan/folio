import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Database } from "../lib/db";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import { retainFailedCover, resolveCoverBarcode, cleanupRetainedCovers } from "../lib/pending-covers";
import { queueManualCover } from "../lib/manual-cover";
import { POST } from "../app/api/discord/inventory/route";
import { manualCoverModal } from "../lib/discord-manual-ui";

async function main() {
  const engine = new PGlite(), db = drizzle(engine, { schema }) as unknown as Database;
  const globals = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
  const previousDb = globals.folioDb, previousFetch = globalThis.fetch;
  const keys = ["INVENTORY_DISCORD_SECRET", "DISCORD_CHANNEL_ID", "INVENTORY_DISCORD_PIN"];
  const previous = keys.map(key => process.env[key]);
  const objects = new Map<string, Buffer>();
  const store = { async put(key: string, data: Buffer) { objects.set(key, data); }, async get(key: string) {
    const data = objects.get(key); if (!data) throw Error("Missing synthetic photo"); return data;
  }, async deleteTemporary(key: string) { assert(key.startsWith("pending/")); objects.delete(key); } };
  try {
    globals.folioDb = Promise.resolve(db);
    globalThis.fetch = async () => { throw Error("Network disabled in isolated test"); };
    process.env.INVENTORY_DISCORD_SECRET = "test-secret"; process.env.DISCORD_CHANNEL_ID = "channel"; process.env.INVENTORY_DISCORD_PIN = "test-pin";
    await applyMigrations(db, readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()
      .map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") })));
    const image = await sharp({ create: { width: 24, height: 32, channels: 3, background: "red" } }).webp().toBuffer();
    const [existing] = await db.insert(schema.books).values({ isbn: "9780805210552", slug: "existing", title: "The Complete Stories",
      author: "Franz Kafka", stock: 7, priceCents: 150000, status: "published" }).returning();
    const retained = await retainFailedCover(db, "photo", "channel", "owner", image, 3, store);
    assert.match(retained.manualCoverId!, /^[a-f0-9]{20}$/);
    const id = retained.manualCoverId!;
    const modal = manualCoverModal(id, "Review the manual draft.\nTitle: The Complete Stories\nAuthor: Franz Kafka").toJSON();
    assert.equal(modal.custom_id, `folio-manual-form:${id}`);
    assert.equal(modal.components.length, 2);
    const fields = modal.components.flatMap(row => "components" in row ? row.components : []);
    assert.equal(fields[0].value, "The Complete Stories"); assert.equal(fields[1].value, "Franz Kafka");
    assert(fields.every(field => field.required));
    const first = await queueManualCover(db, "form1", "channel", "owner", id, "The Complete Stories", "Franz Kafka");
    assert(first.manualDraftChoice); assert.match(first.reply, /already exists/);
    assert.equal((await db.select().from(schema.books)).length, 1, "form submission adds no stock");
    assert.equal((await queueManualCover(db, "form1", "channel", "owner", id, "The Complete Stories", "Franz Kafka")).manualDraftChoice?.id, first.manualDraftChoice.id);
    await assert.rejects(queueManualCover(db, "form1", "channel", "owner", id, "Changed", "Franz Kafka"), /different details/);
    assert.equal((await queueManualCover(db, "other", "channel", "stranger", id, "Title", "Author")).manualDraftChoice, undefined);
    assert.equal((await queueManualCover(db, "other", "elsewhere", "owner", id, "Title", "Author")).manualDraftChoice, undefined);
    await assert.rejects(queueManualCover(db, "bad", "channel", "owner", id, " \n", "Author"));
    await assert.rejects(queueManualCover(db, "long", "channel", "owner", id, "x".repeat(201), "Author"));
    const edited = await queueManualCover(db, "form2", "channel", "owner", id, "Corrected Stories", "F. Kafka");
    assert.notEqual(edited.manualDraftChoice!.id, first.manualDraftChoice.id);
    await resolveCoverBarcode(db, first.manualDraftChoice.id, "channel", "owner", id, store);
    assert.equal((await db.select().from(schema.books)).length, 1, "old preview cannot confirm edited text");
    assert.match((await resolveCoverBarcode(db, edited.manualDraftChoice!.id, "channel", "owner", "SKIP", store)).reply, /saved cover/);
    await resolveCoverBarcode(db, edited.manualDraftChoice!.id, "channel", "stranger", id, store);
    assert.equal((await db.select().from(schema.books)).length, 1);
    const saved = await resolveCoverBarcode(db, edited.manualDraftChoice!.id, "channel", "owner", id, store);
    assert.match(saved.reply, /Received 3 copies/);
    await resolveCoverBarcode(db, edited.manualDraftChoice!.id, "channel", "owner", id, store);
    const [draft] = await db.select().from(schema.books).where(eq(schema.books.isbn, `manual-entry-${id}`));
    assert.equal(draft.title, "Corrected Stories"); assert.equal(draft.author, "F. Kafka"); assert.equal(draft.stock, 3);
    assert.equal(draft.status, "draft"); assert.equal(draft.priceCents, 0);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id, existing.id)))[0].stock, 7);
    const [photo] = await db.select().from(schema.bookPhotos).where(eq(schema.bookPhotos.bookId, draft.id));
    assert.match(photo.objectKey!, /^covers\//); assert(objects.has(photo.objectKey!));
    assert.equal((await queueManualCover(db, "later", "channel", "owner", id, "Title", "Author")).manualDraftChoice, undefined);
    await cleanupRetainedCovers(db, store); assert(objects.has(photo.objectKey!), "temporary cleanup cannot remove the listing photo");
    console.log("PASS edit/replay/owner boundaries; explicit confirmation receives retained quantity once into a separate zero-price draft; existing edition and permanent photo protected");

    const raceCover = await retainFailedCover(db, "race-photo", "channel", "racer", image, 2, store);
    const race = await queueManualCover(db, "race-form", "channel", "racer", raceCover.manualCoverId!, "Race Book", "Author");
    await Promise.allSettled([1, 2].map(() => resolveCoverBarcode(db, race.manualDraftChoice!.id, "channel", "racer", raceCover.manualCoverId!, store)));
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn, `manual-entry-${raceCover.manualCoverId}`)))[0].stock, 2);
    const cancelCover = await retainFailedCover(db, "cancel-photo", "channel", "cancel", image, 1, store);
    const cancel = await queueManualCover(db, "cancel-form", "channel", "cancel", cancelCover.manualCoverId!, "Cancelled", "Author");
    await resolveCoverBarcode(db, cancel.manualDraftChoice!.id, "channel", "cancel", "CANCEL", store);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn, `manual-entry-${cancelCover.manualCoverId}`))).length, 0);
    const expired = await queueManualCover(db, "expire-form", "channel", "cancel", cancelCover.manualCoverId!, "Expired", "Author");
    await db.update(schema.coverBarcodeChoices).set({ expiresAt: new Date(0) }).where(eq(schema.coverBarcodeChoices.id, expired.manualDraftChoice!.id));
    assert.match((await resolveCoverBarcode(db, expired.manualDraftChoice!.id, "channel", "cancel", cancelCover.manualCoverId!, store)).reply, /expired/);
    console.log("PASS simultaneous confirmations, cancellation and expiry cannot add extra stock");

    const api = (secret: string, userId: string) => POST(new Request("http://localhost/api/discord/inventory", { method: "POST",
      headers: { "content-type": "application/json", "x-inventory-secret": secret }, body: JSON.stringify({ messageId: "api-form", channelId: "channel", userId,
        manualCover: { id: cancelCover.manualCoverId, title: "API title", author: "API author" } }) }));
    assert.equal((await api("wrong", "cancel")).status, 401);
    assert.equal((await (await api("test-secret", "stranger")).json()).manualDraftChoice, undefined);
    assert((await (await api("test-secret", "cancel")).json()).manualDraftChoice);
    assert.equal((await db.select().from(schema.books)).length, 3);
    console.log("PASS authenticated modal API queues only an owner-scoped preview; no real R2, Discord or production data touched");
  } finally {
    globals.folioDb = previousDb; globalThis.fetch = previousFetch;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await engine.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
