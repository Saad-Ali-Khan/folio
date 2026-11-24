import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const checks = JSON.parse(readFileSync(process.argv[2] || "photo-release-checks.json", "utf8"));
if (!Array.isArray(checks) || !checks.length) throw new Error("A nonempty photo release manifest is required.");
for (const { route, sha256 } of checks) {
  if (!/^\/api\/books\/[a-z0-9-]+\/photo$/.test(route) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid photo release manifest.");
  const response = await fetch("https://folio.saadalik11.workers.dev" + route, { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (response.status !== 200 || response.headers.get("x-folio-photo-storage") !== "r2" || !response.headers.get("content-type")?.startsWith("image/webp")) {
    await response.body?.cancel(); throw new Error(`R2 release check failed for ${route}; originals retained. Confirm the new Worker is deployed with PHOTO_BUCKET.`);
  }
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 512 * 1024) throw new Error("Photo response exceeds size limit.");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  if (createHash("sha256").update(Buffer.concat(chunks)).digest("hex") !== sha256) throw new Error(`Photo checksum failed for ${route}.`);
  console.log(`PASS ${route}: R2 serving and image checksum verified`);
}
