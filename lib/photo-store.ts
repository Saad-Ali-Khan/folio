// Replaced by the native binding adapter in the Cloudflare build.
import { createR2PhotoStore } from "./r2-photo-store";

export async function getPhotoStore() {
  return createR2PhotoStore();
}
