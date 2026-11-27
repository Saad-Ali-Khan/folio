import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./db";
import { pendingCovers, coverBarcodeChoices, photoObjects } from "./db/schema";
import type { ImportMetadata } from "./import-metadata";
import { copyPhoto, photoIdentity, photoKeyMatches, reservePhotoRead } from "./photo-budget";
import { createR2PhotoStore } from "./r2-photo-store";
import { importDiscordBook } from "./discord-inventory";
import { queueTitleChoice } from "./title-choice";

export type CoverReply = { reply: string; completed?: boolean; titleChoiceId?: string; cleanupAt?: string;
  coverSuggestions?: {id:string;title:string;author:string;coverUrl:string;source:string;note?:string}[];
  suggestedCatalog?: {title:string;coverUrl:string;source:string;artworkUnmatched?:boolean};
  manualCoverId?: string; manualDraftChoice?: { id: string; coverId: string; qty: number };
  coverMatch?: { id: string; covers: { id: string; label: string }[] } };
const ttl = 15 * 60_000;
export type PendingPhotoStore = ReturnType<typeof createR2PhotoStore>;

export async function retainFailedCover(db: Database, sourceMessageId: string, channelId: string, userId: string, data: Buffer, qty: number, store = createR2PhotoStore()): Promise<CoverReply> {
  if (!userId || !Number.isInteger(qty) || qty < 1 || qty > 999) throw new Error("Invalid cover owner or quantity.");
  const row = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('folio:pending-cover-limit'))`);
    const [existing] = await tx.select().from(pendingCovers).where(eq(pendingCovers.sourceMessageId, sourceMessageId));
    if (existing) {
      if (existing.userId !== userId || existing.channelId !== channelId) throw new Error("Cover owner mismatch.");
      return { row: existing, inserted: false };
    }
    const active = await tx.select({ userId: pendingCovers.userId, channelId: pendingCovers.channelId }).from(pendingCovers).where(and(isNull(pendingCovers.cleanedAt), gt(pendingCovers.expiresAt, new Date())));
    if (active.length >= 32 || active.filter(c => c.userId === userId && c.channelId === channelId).length >= 4) throw new Error("Too many retained covers. Wait for them to expire before uploading more.");
    const id = randomBytes(10).toString("hex");
    const [created] = await tx.insert(pendingCovers).values({ id, sourceMessageId, userId, channelId, qty,
      objectKey: `pending/${id}/${photoIdentity(data).slice(7)}`, expiresAt: new Date(Date.now() + ttl) }).returning();
    return { row: created, inserted: true };
  });
  if (row.inserted) {
    await copyPhoto(db, data, store, row.row.id);
    await db.update(pendingCovers).set({ state: "waiting" }).where(eq(pendingCovers.id, row.row.id));
  } else if (row.row.state !== "waiting" || row.row.expiresAt.getTime() <= Date.now()) {
    return { reply: "This cover was already handled, is still saving, or has expired. No stock was added.", cleanupAt: row.row.expiresAt.toISOString() };
  }
  return { reply: `I couldn’t identify this cover. I’ve kept its photo privately for 15 minutes. Send this book’s ISBN barcode, or enter its title and author below. I’ll ask you to confirm before adding stock. Retained quantity: ${qty}.`, manualCoverId: row.row.id, cleanupAt: row.row.expiresAt.toISOString() };
}

export async function queueCoverBarcode(db: Database, sourceMessageId: string, channelId: string, userId: string, metadata: ImportMetadata, qty: number, explicitQty = false): Promise<CoverReply | null> {
  if (!userId || !metadata.isbn) return null;
  const covers = await db.select().from(pendingCovers).where(and(eq(pendingCovers.userId, userId), eq(pendingCovers.channelId, channelId), eq(pendingCovers.state, "waiting"), gt(pendingCovers.expiresAt, new Date()))).orderBy(pendingCovers.expiresAt).limit(4);
  if (!covers.length) return null;
  const [inserted] = await db.insert(coverBarcodeChoices).values({ id: randomBytes(5).toString("hex"), sourceMessageId, userId, channelId, metadata, qty, explicitQty: explicitQty ? 1 : 0, coverIds: covers.map(c => c.id), expiresAt: new Date(Date.now() + ttl) }).onConflictDoNothing().returning();
  const choice = inserted ?? (await db.select().from(coverBarcodeChoices).where(eq(coverBarcodeChoices.sourceMessageId, sourceMessageId)))[0];
  if (!choice || choice.userId !== userId || choice.channelId !== channelId) throw new Error("Barcode confirmation owner mismatch.");
  if (choice.state !== "pending") return choice.result ?? { reply: "This barcode request was already handled. No additional stock was added.", completed: true };
  const eligible = covers.filter(c => choice.coverIds.includes(c.id));
  if (!eligible.length) return { reply: "The retained covers expired. Send the barcode again to continue without a retained cover." };
  return { reply: `Barcode identifies ${choice.metadata.title} by ${choice.metadata.author} (${choice.metadata.isbn}). Are any of these retained covers the same physical book? Choosing a cover receives its retained quantity unless you specified a quantity with the barcode. Barcode only receives ${choice.qty}. No stock has been added yet.`,
    coverMatch: { id: choice.id, covers: eligible.map((c, i) => ({ id: c.id, label: `Cover ${i + 1} · ${choice.explicitQty ? choice.qty : c.qty} ${ (choice.explicitQty ? choice.qty : c.qty) === 1 ? "copy" : "copies"}` })) },
    cleanupAt: new Date(Math.min(...eligible.map(c => c.expiresAt.getTime()))).toISOString() };
}

export async function readRetainedCover(db: Database, id: string, userId: string, channelId: string, store = createR2PhotoStore()) {
  const [cover] = await db.select().from(pendingCovers).where(and(eq(pendingCovers.id, id), eq(pendingCovers.userId, userId), eq(pendingCovers.channelId, channelId), inArray(pendingCovers.state, ["waiting", "claimed"]), gt(pendingCovers.expiresAt, new Date())));
  if (!cover) throw new Error("Retained cover unavailable for this account/channel or expired.");
  const [object] = await db.select().from(photoObjects).where(and(eq(photoObjects.key, cover.objectKey), eq(photoObjects.state, "ready")));
  if (!object) throw new Error("Retained cover is not verified.");
  await reservePhotoRead(db);
  const data = await store.get(cover.objectKey);
  if (!photoKeyMatches(cover.objectKey, data)) throw new Error("Retained cover checksum mismatch.");
  return data;
}

export async function resolveCoverBarcode(db: Database, id: string, channelId: string, userId: string, selection: string, store = createR2PhotoStore()): Promise<CoverReply> {
  if (!/^(?:[a-f0-9]{20}|SKIP|CANCEL)$/.test(selection)) return { reply: "Invalid cover selection." };
  const claim = await db.transaction(async tx => {
    if (/^[a-f0-9]{20}$/.test(selection)) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'folio:manual-cover:' + selection}))`);
    const [choice] = await tx.select().from(coverBarcodeChoices).where(eq(coverBarcodeChoices.id, id)).for("update");
    if (!choice || choice.channelId !== channelId || choice.userId !== userId || !userId) return { error: "Cover confirmation not found for your account and channel." };
    if (choice.state !== "pending") return { result: choice.result ?? { reply: choice.state === "cancelled" ? "Cancelled. Stock unchanged." : "This cover confirmation was already handled. No additional stock was added.", completed: true } };
    if (choice.expiresAt.getTime() <= Date.now()) return { error: "Cover confirmation expired. No stock was added.", completed: true };
    if (choice.metadata.manualEntryId && selection !== "CANCEL" && selection !== choice.metadata.manualEntryId) return { error: "Confirm the saved cover or cancel this draft. No stock was added." };
    if (selection === "CANCEL") {
      await tx.update(coverBarcodeChoices).set({ state: "cancelled", result: { reply: "Cancelled. Stock unchanged.", completed: true } }).where(eq(coverBarcodeChoices.id, id));
      return { error: "Cancelled. Stock unchanged.", completed: true };
    }
    if (selection === "SKIP") return { choice };
    if (!choice.coverIds.includes(selection)) return { error: "That cover was not offered for this request." };
    const [cover] = await tx.select().from(pendingCovers).where(eq(pendingCovers.id, selection)).for("update");
    if (!cover || cover.userId !== userId || cover.channelId !== channelId || cover.expiresAt.getTime() <= Date.now() || !(cover.state === "waiting" || cover.state === "claimed" && cover.claimId === id)) return { error: "That cover expired or was already claimed. No stock was added." };
    // A short processing lease prevents expiry cleanup racing an in-flight confirmation.
    const claimed = cover.state === "claimed" ? cover : (await tx.update(pendingCovers).set({ state: "claimed", claimId: id, expiresAt: new Date(Date.now() + 120_000) }).where(eq(pendingCovers.id, cover.id)).returning())[0];
    return { choice, cover: claimed };
  });
  if ("error" in claim) return { reply: claim.error!, completed: claim.completed };
  if ("result" in claim) return claim.result!;
  let objectKey: string | undefined;
  if (claim.cover) {
    const data = await readRetainedCover(db, claim.cover.id, userId, channelId, store);
    objectKey = (await copyPhoto(db, data, store)).key;
  }
  return db.transaction(async tx => {
    const [choice] = await tx.select().from(coverBarcodeChoices).where(eq(coverBarcodeChoices.id, id)).for("update");
    if (choice.state !== "pending") return { reply: "This cover confirmation was already handled. No additional stock was added.", completed: true };
    if (choice.expiresAt.getTime() <= Date.now()) throw new Error("Cover confirmation expired during processing.");
    if (claim.cover) {
      const [cover] = await tx.select().from(pendingCovers).where(eq(pendingCovers.id, claim.cover.id)).for("update");
      if (!cover || cover.state !== "claimed" || cover.claimId !== id || cover.expiresAt.getTime() <= Date.now()) throw new Error("Cover claim changed during processing.");
    }
    const qty = claim.cover && !choice.explicitQty ? claim.cover.qty : choice.qty;
    const metadata = { ...choice.metadata, ...(objectKey ? { uploadedCoverKey: objectKey } : {}) };
    let result: CoverReply;
    if (metadata.titleOptions) result = { ...await queueTitleChoice(tx as unknown as Database, choice.sourceMessageId, channelId, userId, metadata, qty), completed: true };
    else {
      const received = await importDiscordBook(tx as unknown as Database, choice.sourceMessageId, channelId, metadata, qty);
      result = { reply: received ? `Received ${qty} ${qty === 1 ? "copy" : "copies"} of ${received.title}.${objectKey ? " Retained cover saved as the second listing photo." : " No retained cover attached."} Review inventory before publishing.` : "Already processed. No additional stock was added.", completed: true };
    }
    if (claim.cover) {
      await tx.update(pendingCovers).set({ state: "used", expiresAt: new Date() }).where(eq(pendingCovers.id, claim.cover.id));
      result.cleanupAt = new Date().toISOString();
    }
    await tx.update(coverBarcodeChoices).set({ state: "confirmed", result }).where(eq(coverBarcodeChoices.id, id));
    return result;
  });
}

export async function cleanupRetainedCovers(db: Database, store = createR2PhotoStore()) {
  let cleaned = 0;
  const due = await db.select({ id: pendingCovers.id }).from(pendingCovers).where(and(isNull(pendingCovers.cleanedAt), lte(pendingCovers.expiresAt, new Date()))).limit(50);
  for (const {id} of due) {
    const cover = await db.transaction(async tx => {
      const [row] = await tx.select().from(pendingCovers).where(eq(pendingCovers.id,id)).for("update");
      if (!row || row.cleanedAt || row.expiresAt.getTime() > Date.now()) return null;
      return (await tx.update(pendingCovers).set({ state: "expired", expiresAt: new Date(Date.now()+600_000) }).where(eq(pendingCovers.id,id)).returning())[0];
    });
    if (!cover) continue;
    // Only the temporary prefix is deletable; canonical listing photos cannot be removed.
    await store.deleteTemporary(cover.objectKey);
    await db.transaction(async tx => {
      await tx.delete(photoObjects).where(eq(photoObjects.key,cover.objectKey));
      await tx.update(pendingCovers).set({cleanedAt:new Date()}).where(eq(pendingCovers.id,id));
    });
    cleaned++;
  }
  return cleaned;
}
