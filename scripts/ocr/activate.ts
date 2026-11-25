import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { callLocalOcr, localOcrHealth, ocrStateFile } from "../../lib/local-ocr-client";
import { smokeImages } from "./smoke";

const runtime = path.join(process.cwd(), ".folio-local");
const marker = path.join(runtime, "ocr-enabled");
const delay = () => new Promise(resolve => setTimeout(resolve, 500));
async function ready(timeout = 90_000, failed: () => boolean = () => false) {
  const deadline = Date.now() + timeout;
  do {
    if (failed()) throw Error("Local OCR worker exited during startup. Check .folio-local/logs/ocr.log; mobile OCR was not enabled.");
    const health = await localOcrHealth(); if (health.ready) return health; await delay();
  } while (Date.now() < deadline);
  throw Error("Mobile OCR did not become ready. Check .folio-local/logs/ocr.log; imports can still use Tesseract.");
}
function local(command: string) {
  const result = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", "--import", "tsx", "scripts/local-services.ts", command], {
    cwd: process.cwd(), stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw Error(`Local service ${command} failed; see the specific error above. Mobile mode has not been confirmed active.`);
}
async function shutdownWorker() {
  const config = JSON.parse(readFileSync(ocrStateFile(), "utf8"));
  try { await fetch(`http://127.0.0.1:${config.port}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000) }); }
  catch { /* The worker may close its connection while shutting down. */ }
  for (let attempt = 0; attempt < 12 && existsSync(ocrStateFile()); attempt++) await delay();
  if (existsSync(ocrStateFile())) throw Error("OCR worker did not stop; inspect its service before retrying.");
}
async function main() {
  mkdirSync(runtime, { recursive: true });
  if (process.argv.includes("--disable")) {
    if (existsSync(path.join(runtime, "control.json"))) local("stop");
    if (existsSync(marker)) unlinkSync(marker);
    local("up"); console.log("Tesseract restored; no inventory or messages changed."); return;
  }
  let child: ReturnType<typeof spawn> | undefined;
  let spawnFailed = false;
  if (existsSync(ocrStateFile())) {
    const current = JSON.parse(readFileSync(ocrStateFile(), "utf8"));
    if (!Number.isInteger(current.pid) || current.pid <= 0) throw Error("Invalid OCR state; inspect it before starting a second worker.");
    try { process.kill(current.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(ocrStateFile()); }
  }
  if (!existsSync(ocrStateFile())) {
    child = spawn(process.execPath, ["--import", "tsx", "scripts/ocr/server.ts"], { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });
    child.on("error", () => { spawnFailed = true; });
  }
  try {
    console.log("Warming local mobile OCR; cached model weights are reused. No inventory or catalog requests.");
    await ready(90_000, () => spawnFailed || Boolean(child && (child.exitCode !== null || child.signalCode !== null)));
    const { page: image, line: lineImage } = await smokeImages();
    const diagnostic = { generatedAt: new Date().toISOString(), fixture: "synthetic Folio local OCR check; no uploaded cover text",
      mobile: [] as unknown[], direct: undefined as unknown };
    const saveDiagnostic = () => writeFileSync(path.join(runtime, "ocr-smoke-check.json"), JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
    for (let i = 0; i < 2; i++) {
      const result = await callLocalOcr(image, "detect");
      diagnostic.mobile.push(result); saveDiagnostic();
      if (!result.lines?.some(line => /folio|local|check/i.test(line.text))) throw Error("Mobile recognition smoke check failed; activation stopped.");
    }
    const line = await callLocalOcr(lineImage, "recognize");
    const info = await sharp(lineImage).metadata();
    diagnostic.direct = { ...line, width: info.width, height: info.height }; saveDiagnostic();
    if (!/folio|local|check/i.test(line.text ?? "") || (line.confidence ?? 0) < 65) {
      throw Error(`Direct line recognition smoke check failed: ${JSON.stringify(line.text)}, confidence ${line.confidence?.toFixed(1)}. Activation stopped; synthetic diagnostics saved in .folio-local/ocr-smoke-check.json.`);
    }
    const health = await localOcrHealth();
    if (!health.ready || health.modelLoads !== 1) throw Error("Persistent worker readiness check failed.");
    console.log("PASS mobile scan twice in one worker; direct-row recognition; models retained; no books or stock touched.");
    if (process.argv.includes("--check")) return;
    await shutdownWorker();
    if (existsSync(path.join(runtime, "control.json"))) local("stop");
    writeFileSync(marker, "Mobile-first OCR enabled after persistent-worker smoke check.\n", { mode: 0o600 });
    local("up");
    await ready();
    console.log("PASS mobile-first OCR enabled under the startup supervisor. Tesseract and crops are fallback stages. No photos replayed, inventory changed or messages sent.");
  } finally {
    if (child && child.exitCode === null) {
      // Stop only the preflight worker created by this invocation.
      if (existsSync(ocrStateFile()) && JSON.parse(readFileSync(ocrStateFile(), "utf8")).pid === child.pid) await shutdownWorker();
      else child.kill();
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
