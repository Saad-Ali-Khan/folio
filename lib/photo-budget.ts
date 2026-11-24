import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./db";
import { photoObjects, photoUploadMonths } from "./db/schema";

export const PHOTO_LIMITS = Object.freeze({ bytes: 512 * 1024, storedBytes: 8_000_000_000, monthlyPuts: 10_000, monthlyReads: 1_000_000 });

export async function reservePhotoRead(db: Database) {
  const result = await db.insert(photoUploadMonths).values({
    month: sql`to_char(current_timestamp at time zone 'UTC', 'YYYY-MM')`, reads: 1,
  }).onConflictDoUpdate({ target: photoUploadMonths.month, set: { reads: sql`${photoUploadMonths.reads} + 1` },
    setWhere: sql`${photoUploadMonths.reads} < ${PHOTO_LIMITS.monthlyReads}` }).returning({ month: photoUploadMonths.month });
  if (!result.length) throw new Error("Folio's monthly R2 read limit has been reached.");
}

export function photoIdentity(data: Buffer) {
  if (!data.length || data.length > PHOTO_LIMITS.bytes) throw new Error("Photo exceeds the 512 KiB limit or is empty.");
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") throw new Error("Only optimized WebP photos can be migrated.");
  return `covers/${createHash("sha256").update(data).digest("hex")}.webp`;
}

export function photoKeyMatches(key: string, data: Buffer) {
  const canonical = photoIdentity(data);
  return key === canonical || (/^pending\/[a-f0-9]{20}\/[a-f0-9]{64}\.webp$/.test(key) && key.endsWith(canonical.slice(7)));
}

export async function reservePhoto(db: Database, data: Buffer, temporaryId?: string): Promise<{ key: string; upload: boolean }> {
  const canonical = photoIdentity(data);
  if (temporaryId && !/^[a-f0-9]{20}$/.test(temporaryId)) throw new Error("Invalid temporary cover ID.");
  const key = temporaryId ? `pending/${temporaryId}/${canonical.slice(7)}` : canonical;
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('folio:photo-budget'))`);
    const [existing] = await tx.select().from(photoObjects).where(eq(photoObjects.key, key));
    if (existing) {
      if (existing.bytes !== data.length) throw new Error("Photo ledger size mismatch.");
      if (existing.state !== "ready") throw new Error("Photo upload is unresolved. Verify the reserved object before retrying.");
      return { key, upload: false };
    }
    const [{ used }] = await tx.select({ used: sql<string>`coalesce(sum(${photoObjects.bytes}), 0)` }).from(photoObjects);
    if (Number(used) + data.length > PHOTO_LIMITS.storedBytes) throw new Error("Folio's 8 GB R2 storage limit has been reached.");
    // Use database UTC time so parallel clients and clock skew cannot reset budgets.
    const [{ month }] = await tx.select({ month: sql<string>`to_char(current_timestamp at time zone 'UTC', 'YYYY-MM')` }).from(sql`(select 1) as clock`);
    const [usage] = await tx.select().from(photoUploadMonths).where(eq(photoUploadMonths.month, month));
    if ((usage?.attempts ?? 0) >= PHOTO_LIMITS.monthlyPuts) throw new Error("Folio's monthly R2 upload limit has been reached.");
    await tx.insert(photoUploadMonths).values({ month, attempts: 1 }).onConflictDoUpdate({ target: photoUploadMonths.month, set: { attempts: sql`${photoUploadMonths.attempts} + 1` } });
    await tx.insert(photoObjects).values({ key, bytes: data.length });
    return { key, upload: true };
  });
}

export async function verifyPhoto(db: Database, key: string, data: Buffer) {
  if (!photoKeyMatches(key, data)) throw new Error("R2 photo checksum mismatch; original retained.");
  const rows = await db.update(photoObjects).set({ state: "ready" }).where(sql`${photoObjects.key} = ${key} and ${photoObjects.bytes} = ${data.length}`).returning();
  if (!rows.length) throw new Error("Photo reservation is missing or has a different size.");
}

export async function copyPhoto(db: Database, data: Buffer, store: { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer> }, temporaryId?: string) {
  const reservation = await reservePhoto(db, data, temporaryId);
  if (reservation.upload) {
    // No automatic retry: a lost response may follow a successful PUT.
    await store.put(reservation.key, data);
    await reservePhotoRead(db);
    await verifyPhoto(db, reservation.key, await store.get(reservation.key));
  }
  return reservation;
}
