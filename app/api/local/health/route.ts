import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import englishData from "@tesseract.js-data/eng";
import sharp from "sharp";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.INVENTORY_DISCORD_SECRET?.trim();
  const supplied = Buffer.from(request.headers.get("x-inventory-secret") ?? "");
  const expected = Buffer.from(secret ?? "");
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return new Response(null, { status: 403 });
  }
  const configured = ["DISCORD_CHANNEL_ID", "INVENTORY_DISCORD_PIN", "DATABASE_URL"].every(key => Boolean(process.env[key]?.trim()));
  const ocrAssets = existsSync(path.join(path.dirname(englishData.langPath), "4.0.0_best_int", "eng.traineddata.gz"));
  const ready = configured && ocrAssets && Boolean(sharp.versions.vips);
  return Response.json({ service: "folio-local-inventory", ready, configured, ocrAssets, database: "not probed" }, {
    status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" },
  });
}
