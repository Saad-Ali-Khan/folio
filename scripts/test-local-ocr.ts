import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { startOcrServer } from "./ocr/server";
import { callLocalOcr, localOcrHealth, type OcrResult } from "../lib/local-ocr-client";

async function main() {
  const folder = mkdtempSync(path.join(process.cwd(), ".folio-local-test-"));
  const file = path.join(folder, "ocr.json");
  let release: ((result: OcrResult) => void) | undefined;
  let hold = false, calls = 0, stopped = false;
  const result = { lines: [{ text: "Book", top: .1, height: .1, left: .1, confidence: 99 }] };
  const backend = { ready: true, modelLoads: 1, call: async () => {
    calls++; if (hold) return new Promise<OcrResult>(resolve => { release = resolve; }); return result;
  }, stop: () => { stopped = true; } };
  const server = await startOcrServer(backend, file);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 403);
    assert.equal((await localOcrHealth(file)).ready, true);
    await callLocalOcr(Buffer.from("test"), "detect", undefined, file);
    await callLocalOcr(Buffer.from("test"), "detect", undefined, file);
    assert.equal((await localOcrHealth(file)).modelLoads, 1);
    assert.equal(calls, 2, "health never starts inference");
    hold = true;
    const first = callLocalOcr(Buffer.from("test"), "detect", undefined, file);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(callLocalOcr(Buffer.from("test"), "detect", undefined, file), /503/);
    release(result); await first; hold = false;
    backend.ready = false;
    assert.equal((await localOcrHealth(file)).ready, false);
    await assert.rejects(callLocalOcr(Buffer.from("test"), "detect", undefined, file), /503/);
    backend.ready = true;
    const config = JSON.parse(readFileSync(file, "utf8"));
    const oversize = await fetch(`http://127.0.0.1:${server.port}/scan`, { method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "image/png", "x-ocr-mode": "detect" }, body: new Uint8Array(12 * 1024 * 1024 + 1) });
    assert.equal(oversize.status, 413);
    await server.stop(); assert(stopped); assert.equal(existsSync(file), false);
    console.log("PASS private loopback auth, shared readiness, persistent backend, busy/unavailable rejection, image limit and owned-state cleanup. No models, network catalog or inventory writes.");
  } finally { release?.(result); await server.stop(); rmSync(folder, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
