import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import sharp from "sharp";
import type { Database } from "../lib/db";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import { copyPhoto, photoIdentity, PHOTO_LIMITS, reservePhoto, reservePhotoRead, verifyPhoto } from "../lib/photo-budget";

async function main() {
  const engine = new PGlite();
  try {
    const db = drizzle(engine, { schema }) as unknown as Database;
    await applyMigrations(db, readdirSync("drizzle").filter(n => n.endsWith(".sql")).sort().map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") })));
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).webp().toBuffer();
    const other = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).webp().toBuffer();
    const [book] = await db.insert(schema.books).values({ isbn: "manual-cover-budget", slug: "budget-test", title: "Test", author: "Test", stock: 1, priceCents: 100 }).returning();
    await db.insert(schema.bookPhotos).values({ bookId: book.id, data: image.toString("base64") });
    let puts = 0; const objects = new Map<string, Buffer>();
    const store = { async put(key: string, data: Buffer) { puts++; objects.set(key, data); }, async get(key: string) { return objects.get(key)!; } };
    const results = await Promise.allSettled([copyPhoto(db, image, store), copyPhoto(db, image, store)]);
    assert.ok(results.some(r => r.status === "fulfilled"));
    assert.equal(puts, 1);
    await copyPhoto(db, image, store); assert.equal(puts, 1);
    assert.equal((await db.select().from(schema.photoUploadMonths))[0].attempts, 1);
    assert.equal((await db.select().from(schema.photoObjects))[0].state, "ready");
    console.log("PASS concurrent duplicate copies and replay cannot create duplicate PUTs");

    await assert.rejects(copyPhoto(db, other, { ...store, async put() { puts++; throw new Error("lost response"); } }), /lost response/);
    await assert.rejects(copyPhoto(db, other, store), /unresolved/);
    assert.equal(puts, 2); assert.equal((await db.select().from(schema.photoUploadMonths))[0].attempts, 2);
    await assert.rejects(verifyPhoto(db, photoIdentity(other), image), /checksum/);
    assert.equal((await db.select().from(schema.photoObjects)).filter(r => r.state === "reserved").length, 1);
    await verifyPhoto(db, photoIdentity(other), other);
    assert.equal((await reservePhoto(db, other)).upload, false);
    console.log("PASS failed upload retains capacity and attempt; checksum verification resolves uncertainty without another PUT");

    await engine.exec("update photo_upload_months set reads = 999999");
    const reads = await Promise.allSettled([reservePhotoRead(db), reservePhotoRead(db)]);
    assert.equal(reads.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await db.select().from(schema.photoUploadMonths))[0].reads, 1_000_000);
    console.log("PASS concurrent reads cannot exceed the last remaining monthly read allowance");

    await engine.exec("delete from photo_objects; update photo_upload_months set attempts = 10000;");
    await assert.rejects(copyPhoto(db, image, store), /monthly/);
    assert.equal(puts, 2); assert.equal((await db.select().from(schema.photoObjects)).length, 0);
    await engine.exec("delete from photo_upload_months; insert into photo_objects (key, bytes) select 'synthetic-' || n, 500000 from generate_series(1, 16000) as n;");
    await assert.rejects(copyPhoto(db, image, store), /8 GB/);
    assert.equal(puts, 2); assert.equal((await db.select().from(schema.photoUploadMonths)).length, 0);
    assert.throws(() => photoIdentity(Buffer.alloc(PHOTO_LIMITS.bytes + 1)), /512 KiB/);
    assert.throws(() => photoIdentity(Buffer.from("not a webp")), /WebP/);
    assert.equal((await db.select().from(schema.bookPhotos))[0].data, image.toString("base64"));
    assert.equal((await db.select().from(schema.books))[0].stock, 1);
    console.log("PASS storage, monthly and input limits block before PUT; legacy photo and stock unchanged");
  } finally { await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
