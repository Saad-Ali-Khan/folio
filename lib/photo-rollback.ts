import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "./db";
import { bookPhotos, titleChoices } from "./db/schema";
import { readObjectPhoto } from "./book-photos";

/** Materialize verified legacy bytes before rolling back to a pre-R2 release. */
export async function restorePhotoFallbacks(db: Database) {
  let photos = 0, choices = 0;
  for (const photo of await db.select().from(bookPhotos).where(and(eq(bookPhotos.data, ""), isNotNull(bookPhotos.objectKey)))) {
    const data = (await readObjectPhoto(db, photo.objectKey!)).toString("base64");
    const rows = await db.update(bookPhotos).set({ data }).where(and(eq(bookPhotos.bookId, photo.bookId), eq(bookPhotos.data, ""), eq(bookPhotos.objectKey, photo.objectKey!))).returning();
    if (!rows.length) throw new Error("Photo changed during rollback preparation; retry before deploying old code.");
    photos++;
  }
  for (const choice of await db.select().from(titleChoices)) {
    const { uploadedCoverKey, uploadedCover } = choice.metadata;
    if (!uploadedCoverKey || uploadedCover) continue;
    const data = (await readObjectPhoto(db, uploadedCoverKey)).toString("base64");
    const rows = await db.update(titleChoices).set({ metadata: { ...choice.metadata, uploadedCover: data } })
      .where(and(eq(titleChoices.id, choice.id), eq(titleChoices.metadata, choice.metadata))).returning();
    if (!rows.length) throw new Error("Title choice changed during rollback preparation; retry before deploying old code.");
    choices++;
  }
  return { photos, choices };
}
