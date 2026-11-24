import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PHOTO_LIMITS } from "@/lib/photo-budget";

type PhotoBucket = { get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream } | null> };
export async function getPhotoStore() {
  const { env } = await getCloudflareContext({ async: true });
  const bucket = (env as unknown as { PHOTO_BUCKET?: PhotoBucket }).PHOTO_BUCKET;
  if (!bucket) throw new Error("PHOTO_BUCKET binding is missing.");
  return createBoundPhotoStore(bucket);
}

export function createBoundPhotoStore(bucket: PhotoBucket) {
  return {
    async get(key: string) {
      if (!/^covers\/[a-f0-9]{64}\.webp$/.test(key)) throw new Error("Invalid photo object key.");
      const object = await bucket.get(key);
      if (!object) throw new Error("R2 photo is unavailable.");
      if (object.size > PHOTO_LIMITS.bytes) { await object.body.cancel(); throw new Error("R2 photo exceeds size limit."); }
      return Buffer.from(await object.arrayBuffer());
    },
  };
}
