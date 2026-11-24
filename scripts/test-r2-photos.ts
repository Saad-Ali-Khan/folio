import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Database } from "../lib/db";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import { storeImportPhoto } from "../lib/import-photo";
import { readBookPhoto } from "../lib/book-photos";
import { photoIdentity } from "../lib/photo-budget";
import { queueTitleChoice, resolveTitleChoice } from "../lib/title-choice";
import { importDiscordBook } from "../lib/discord-inventory";
import { GET } from "../app/api/books/[slug]/photo/route";
import { createBoundPhotoStore } from "../deploy/cloudflare/photo-store";
import { restorePhotoFallbacks } from "../lib/photo-rollback";
import { attachBackupPhotos, open, recoverySql, seal, takeSnapshot, verifyRestore } from "./backup-lib";

async function main() {
  const engine = new PGlite(); const originalFetch = globalThis.fetch;
  const envBefore = { ...process.env };
  const globals = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
  const db = drizzle(engine, { schema }) as unknown as Database;
  globals.folioDb = Promise.resolve(db);
  try {
    const migrations = readdirSync("drizzle").filter(n => n.endsWith(".sql")).sort().map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") }));
    await applyMigrations(db, migrations);
    const image = await sharp({ create: { width: 30, height: 30, channels: 3, background: "green" } }).webp().toBuffer();
    const key = photoIdentity(image), objects = new Map<string, Buffer>(); let puts = 0, gets = 0;
    const nativeStore = createBoundPhotoStore({ async get() { return { size: image.length, body: new ReadableStream(), async arrayBuffer() { return new Uint8Array(image).buffer; } }; } });
    assert.deepEqual(await nativeStore.get(key), image);
    await assert.rejects(nativeStore.get("../private"), /Invalid/);
    await assert.rejects(createBoundPhotoStore({ async get() { return null; } }).get(key), /unavailable/);
    console.log("PASS native Worker binding returns bounded private objects and rejects invalid/missing keys");
    process.env.R2_ACCOUNT_ID = "a".repeat(32); process.env.R2_ACCESS_KEY_ID = "test-key"; process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.PHOTO_STORAGE = "r2";
    globalThis.fetch = async input => {
      assert.ok(input instanceof Request); const request = input as Request;
      const url = new URL(request.url); assert.equal(url.hostname, "a".repeat(32) + ".r2.cloudflarestorage.com");
      assert.ok(request.headers.get("authorization"));
      const objectKey = url.pathname.replace("/folio-photos/", "");
      if (request.method === "PUT") {
        puts++; assert.equal(request.headers.get("if-none-match"), "*");
        assert.equal(request.headers.get("content-length"), String(image.length));
        assert.equal(request.headers.get("x-amz-storage-class"), "STANDARD");
        objects.set(objectKey, Buffer.from(await request.arrayBuffer())); return new Response(null);
      }
      gets++; const data = objects.get(objectKey); return new Response(data ? new Uint8Array(data) : null, { status: data ? 200 : 404 });
    };
    const photo = await storeImportPhoto(db, image.toString("base64"));
    assert.deepEqual(photo, { uploadedCoverKey: key }); assert.equal(puts, 1);
    assert.deepEqual(await storeImportPhoto(db, image.toString("base64")), photo); assert.equal(puts, 1);
    const meta = { ...photo, title: "Photo test", author: "Test author", isbn: null, coverUrl: null, coverWorkId: "OL123W", titleOptions: { english: "Photo test", original: "Original test" } };
    const prompt = await queueTitleChoice(db, "r2-test", "channel", "operator", meta, 1);
    assert.ok(prompt.titleChoiceId);
    const pending = (await db.select().from(schema.titleChoices))[0];
    assert.equal(pending.metadata.uploadedCover, undefined);
    assert.equal((await db.select().from(schema.books)).length, 0);
    await resolveTitleChoice(db, prompt.titleChoiceId!, "channel", "operator", "ENGLISH");
    await resolveTitleChoice(db, prompt.titleChoiceId!, "channel", "operator", "ENGLISH");
    const [book] = await db.select().from(schema.books); assert.equal(book.stock, 1);
    const [saved] = await db.select().from(schema.bookPhotos); assert.equal(saved.data, ""); assert.equal(saved.objectKey, key);
    assert.deepEqual(await readBookPhoto(db, saved), image);
    console.log("PASS signed, create-only R2 import; pending choice holds a reference; repeated confirmation adds stock once");

    const get = () => GET(new Request("http://localhost/api/books/photo-test/photo"), { params: Promise.resolve({ slug: book.slug }) });
    const beforeDraftGet = gets; assert.equal((await get()).status, 404); assert.equal(gets, beforeDraftGet);
    await db.update(schema.books).set({ status: "published", priceCents: 10000 }).where(eq(schema.books.id, book.id));
    const response = await get(); assert.equal(response.status, 200); assert.equal(response.headers.get("x-folio-photo-storage"), "r2");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    const good = objects.get(key)!; objects.set(key, Buffer.from("corrupt"));
    assert.equal((await get()).status, 503);
    assert.deepEqual(await readBookPhoto(db, { ...saved, data: image.toString("base64") }), image);
    objects.set(key, good);
    console.log("PASS draft access denied before R2 read; published bytes verified; corruption fails closed or uses preserved fallback");

    const snapshot = await takeSnapshot(db, migrations);
    assert.throws(() => seal(snapshot, randomBytes(32)), /missing/);
    await attachBackupPhotos(snapshot, async objectKey => objects.get(objectKey)!);
    const archive = open(seal(snapshot, Buffer.alloc(32, 1)), Buffer.alloc(32, 1));
    const report = await verifyRestore(archive); assert.equal(report.objects, 1);
    const recovery = new PGlite();
    try {
      await recovery.exec(recoverySql(archive));
      const recovered = (await recovery.query<{data:string}>("select data from book_photos")).rows[0];
      assert.deepEqual(Buffer.from(recovered.data, "base64"), image);
      const choice = (await recovery.query<{metadata:{uploadedCover:string}}>("select metadata from title_choices")).rows[0];
      assert.equal(choice.metadata.uploadedCover, image.toString("base64"));
    } finally { await recovery.close(); }
    const tampered = structuredClone(archive); tampered.objects![0].data = Buffer.from("corrupt").toString("base64");
    assert.throws(() => seal(tampered, randomBytes(32)));
    console.log("PASS encrypted R2 bytes archive and offline restore, including pending-choice fallback; missing/corrupt photos rejected");

    assert.deepEqual(await restorePhotoFallbacks(db), { photos: 1, choices: 1 });
    assert.deepEqual(await restorePhotoFallbacks(db), { photos: 0, choices: 0 });
    assert.equal((await db.select().from(schema.bookPhotos))[0].data, image.toString("base64"));
    assert.equal((await db.select().from(schema.books))[0].stock, 1);
    await db.update(schema.bookPhotos).set({ data: "" }).where(eq(schema.bookPhotos.bookId, book.id));
    console.log("PASS rollback materializes legacy photo and title-choice bytes once without changing stock");

    await engine.exec("update photo_upload_months set reads=1000000");
    const beforeLimit = gets; assert.equal((await get()).status, 503); assert.equal(gets, beforeLimit);
    await db.update(schema.books).set({ status: "draft" }).where(eq(schema.books.id, book.id));
    await assert.rejects(importDiscordBook(db, "bad-reference", "channel", { ...meta, uploadedCoverKey: "covers/" + "b".repeat(64) + ".webp" }, 1), /not been verified/);
    assert.equal((await db.select().from(schema.books))[0].stock, 1);
    console.log("PASS read cap blocks external access; unverified photo references roll back stock changes");
  } finally {
    globalThis.fetch = originalFetch; process.env = envBefore; delete globals.folioDb; await engine.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
