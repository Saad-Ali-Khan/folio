import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { photoObjects } from "./db/schema";
import { photoIdentity, reservePhotoRead } from "./photo-budget";
import { getPhotoStore } from "./photo-store";

export async function readyPhotoKey(db: Database, key: string) {
  if (!/^covers\/[a-f0-9]{64}\.webp$/.test(key)) throw new Error("Invalid uploaded photo reference.");
  const [object] = await db.select().from(photoObjects).where(eq(photoObjects.key, key));
  if (!object || object.state !== "ready") throw new Error("Uploaded photo has not been verified.");
  return key;
}

export async function readObjectPhoto(db: Database, key: string) {
  await readyPhotoKey(db, key);
  await reservePhotoRead(db);
  const data = await (await getPhotoStore()).get(key);
  if (photoIdentity(data) !== key) throw new Error("Uploaded photo checksum mismatch.");
  return data;
}

export async function readBookPhotoResult(db: Database, photo: { data: string; objectKey?: string | null }) {
  if (photo.objectKey) {
    try { return { data: await readObjectPhoto(db, photo.objectKey), source: "r2" }; }
    catch {
      if (!photo.data) throw new Error("Uploaded photo is temporarily unavailable.");
      // A preserved original also permits rollback or recovery without R2.
    }
  }
  if (!photo.data) throw new Error("Uploaded photo is missing.");
  return { data: Buffer.from(photo.data, "base64"), source: "database" };
}

export async function readBookPhoto(db: Database, photo: { data: string; objectKey?: string | null }) {
  return (await readBookPhotoResult(db, photo)).data;
}
