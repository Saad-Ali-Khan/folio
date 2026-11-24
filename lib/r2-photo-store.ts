import { AwsClient } from "aws4fetch";
import { PHOTO_LIMITS } from "./photo-budget";

export type R2PhotoStore = { put(key:string,data:Buffer):Promise<void>; get(key:string):Promise<Buffer>; deleteTemporary(key:string):Promise<void> };
export function createR2PhotoStore(): R2PhotoStore {
  const account = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !accessKeyId || !secretAccessKey) throw new Error("Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY locally first.");
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto", retries: 0 });
  const base = `https://${account}.r2.cloudflarestorage.com/folio-photos/`;
  async function request(key: string, method: string, data?: Buffer) {
    if (!/^(?:covers|pending\/[a-f0-9]{20})\/[a-f0-9]{64}\.webp$/.test(key)) throw new Error("Invalid photo object key.");
    const signed = await client.sign(base + key, { method, headers: data ? { "Content-Type": "image/webp", "Content-Length": String(data.length), "x-amz-storage-class": "STANDARD", "If-None-Match": "*" } : {}, body: data ? new Uint8Array(data) : undefined });
    const response = await fetch(signed, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`R2 ${method} failed (HTTP ${response.status}); reservation retained.`); }
    return response;
  }
  return {
    async deleteTemporary(key: string) {
      if (!/^pending\/[a-f0-9]{20}\/[a-f0-9]{64}\.webp$/.test(key)) throw new Error("Only temporary covers may be deleted by cleanup.");
      await (await request(key, "DELETE")).body?.cancel();
    },
    async put(key: string, data: Buffer) { await (await request(key, "PUT", data)).body?.cancel(); },
    async get(key: string) {
      const response = await request(key, "GET");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("R2 returned an empty photo.");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > PHOTO_LIMITS.bytes) throw new Error("R2 photo exceeds the size limit.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    },
  };
}
