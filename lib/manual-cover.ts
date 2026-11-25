import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./db";
import { books, pendingCovers, coverBarcodeChoices } from "./db/schema";
import type { CoverReply } from "./pending-covers";

function field(value: unknown, max: number) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) throw Error("Enter a title and author on one line each.");
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text || text.length > max) throw Error(`Title/author must contain 1–${max} characters.`);
  return text;
}
export async function queueManualCover(db: Database, sourceMessageId: string, channelId: string, userId: string,
  coverId: string, rawTitle: unknown, rawAuthor: unknown): Promise<CoverReply> {
  if (!/^[a-f0-9]{20}$/.test(coverId) || !userId || !sourceMessageId || sourceMessageId.length > 100) throw Error("Invalid manual cover request.");
  const title = field(rawTitle, 200), author = field(rawAuthor, 140);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'folio:manual-cover:' + coverId}))`);
    const [cover] = await tx.select().from(pendingCovers).where(and(eq(pendingCovers.id, coverId), eq(pendingCovers.userId, userId),
      eq(pendingCovers.channelId, channelId), eq(pendingCovers.state, "waiting"), gt(pendingCovers.expiresAt, new Date()))).for("update");
    if (!cover) return { reply: "This saved cover expired or is unavailable for your account/channel. No stock was added." };
    const source = `manual:${sourceMessageId}`;
    const [replay] = await tx.select().from(coverBarcodeChoices).where(eq(coverBarcodeChoices.sourceMessageId, source));
    if (replay && (replay.userId !== userId || replay.channelId !== channelId || replay.metadata.manualEntryId !== coverId ||
      replay.metadata.title !== title || replay.metadata.author !== author)) throw Error("This form was already submitted with different details.");
    if (replay && replay.state !== "pending") return { reply: "This manual draft request was already handled. No additional stock was added.", completed: true };
    let choice = replay;
    if (!choice) {
      // Editing invalidates the old preview so an old button cannot confirm new text.
      await tx.update(coverBarcodeChoices).set({ state: "cancelled" }).where(and(eq(coverBarcodeChoices.userId, userId),
        eq(coverBarcodeChoices.channelId, channelId), eq(coverBarcodeChoices.state, "pending"),
        sql`${coverBarcodeChoices.metadata}->>'manualEntryId' = ${coverId}`));
      [choice] = await tx.insert(coverBarcodeChoices).values({ id: randomBytes(5).toString("hex"), sourceMessageId: source,
        userId, channelId, coverIds: [coverId], qty: cover.qty, explicitQty: 0, expiresAt: cover.expiresAt,
        metadata: { title, author, isbn: null, coverUrl: null, manualEntryId: coverId,
          description: "Title and author entered and confirmed by the operator. ISBN, publisher, edition and translator remain unverified." },
      }).returning();
    }
    const existing = await tx.select({ id: books.id }).from(books).where(and(sql`lower(${books.title}) = ${title.toLowerCase()}`,
      sql`lower(${books.author}) = ${author.toLowerCase()}`)).limit(1);
    return { reply: `Review the manual draft.\nTitle: ${title}\nAuthor: ${author}\nQuantity: ${cover.qty}\nISBN, edition and translator are not verified. Confirming creates a separate draft with the saved photo; it does not merge with another listing. No stock has been added.${existing.length ? "\nA matching title/author already exists. Use its ISBN if you intend to add to that edition instead." : ""}`,
      manualDraftChoice: { id: choice.id, coverId, qty: cover.qty },
      coverMatch: { id: choice.id, covers: [{ id: coverId, label: `Saved cover · ${cover.qty} ${cover.qty === 1 ? "copy" : "copies"}` }] },
      cleanupAt: cover.expiresAt.toISOString() };
  });
}
