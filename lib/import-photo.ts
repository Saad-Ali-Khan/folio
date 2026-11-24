import type { Database } from "./db";
import { copyPhoto } from "./photo-budget";
import { createR2PhotoStore } from "./r2-photo-store";

export async function storeImportPhoto(db: Database, base64: string) {
  if (process.env.PHOTO_STORAGE !== "r2") return { uploadedCover: base64 };
  try {
    const { key } = await copyPhoto(db, Buffer.from(base64, "base64"), createR2PhotoStore());
    return { uploadedCoverKey: key };
  } catch {
    throw new PhotoImportError("The cover could not be saved to photo storage. No stock was added. Ask the operator to check photo storage and its limits before retrying.");
  }
}
export class PhotoImportError extends Error {}
