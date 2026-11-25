import { readFileSync } from "node:fs";
import path from "node:path";
import type { LocatedLine } from "./cover-geometry";

export type OcrResult = { lines?: LocatedLine[]; text?: string; confidence?: number };
export function ocrStateFile() { return path.join(process.cwd(), ".folio-local", "ocr.json"); }
function state(file: string) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw Error("Invalid OCR service state");
  return value as { port: number; token: string };
}
export async function localOcrHealth(file = ocrStateFile()) {
  try {
    const config = state(file);
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, {
      headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(2000), redirect: "error" });
    const body = await response.json();
    return { ready: response.ok && body.service === "folio-ocr" && body.ready === true,
      engine: "paddle-mobile", modelLoads: body.modelLoads, busy: body.busy === true };
  } catch { return { ready: false, engine: "paddle-mobile" }; }
}
export async function callLocalOcr(image: Buffer, mode: "detect" | "recognize", signal?: AbortSignal, file = ocrStateFile()): Promise<OcrResult> {
  const config = state(file);
  const response = await fetch(`http://127.0.0.1:${config.port}/scan`, {
    method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "image/png", "x-ocr-mode": mode },
    body: new Uint8Array(image), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(28_000)]) : AbortSignal.timeout(28_000) });
  if (!response.ok) throw Error(`Local OCR unavailable (${response.status})`);
  const result = await response.json() as OcrResult;
  const text = (value: unknown) => typeof value === "string" && value.length <= 500;
  const confidence = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  if (mode === "recognize") {
    if (!text(result.text) || !confidence(result.confidence)) throw Error("Invalid local OCR response");
  } else if (!Array.isArray(result.lines) || result.lines.length > 500 || result.lines.some(line => !text(line.text) || !confidence(line.confidence) ||
    ![line.top, line.height, line.left].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1))) throw Error("Invalid local OCR response");
  return result;
}
