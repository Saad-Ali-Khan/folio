import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { acquireLock, createLog, logStream } from "../local-runtime";
import type { OcrResult } from "../../lib/local-ocr-client";

type Backend = { ready: boolean; modelLoads: number; call(image: Buffer, mode: string): Promise<OcrResult>; stop(): void };
export async function startOcrServer(backend: Backend, file: string) {
  const token = randomBytes(32).toString("hex");
  let busy = false;
  const server = createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({ service: "folio-ocr", ready: backend.ready, busy, modelLoads: backend.modelLoads })); return;
      }
      if (request.method === "POST" && request.url === "/shutdown") {
        response.end("{}"); void stop(); return;
      }
      if (request.method !== "POST" || request.url !== "/scan") { response.writeHead(404).end(); return; }
      const mode = request.headers["x-ocr-mode"];
      if (!["detect", "recognize"].includes(String(mode)) || request.headers["content-type"] !== "image/png") { response.writeHead(400).end(); return; }
      if (!backend.ready || busy) { response.writeHead(503).end(); return; }
      if (Number(request.headers["content-length"]) > 12 * 1024 * 1024) { response.writeHead(413).end(); return; }
      busy = true;
      try {
        request.setTimeout(5000, () => request.destroy());
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 12 * 1024 * 1024) { response.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        request.setTimeout(0);
        const result = await backend.call(Buffer.concat(chunks), String(mode));
        response.end(JSON.stringify(result));
      } finally { busy = false; }
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("OCR loopback bind failed");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 });
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    backend.stop();
    server.closeAllConnections(); server.close();
    try { if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file); } catch { /* Already removed. */ }
  }
  return { port: address.port, token, stop };
}

function createBackend(root: string, fatal: () => void): Backend {
  const log = createLog(path.join(root, ".folio-local/logs/ocr.log"), []);
  const linuxRoot = process.platform === "win32"
    ? execFileSync("wsl.exe", ["--exec", "wslpath", "-u", root], { windowsHide: true, encoding: "utf8", timeout: 10_000 }).trim() : root;
  if (!linuxRoot.startsWith("/")) throw Error("Cannot resolve WSL OCR directory");
  const child = process.platform === "win32"
    ? spawn("wsl.exe", ["--exec", "bash", `${linuxRoot}/scripts/ocr/run-worker.sh`, linuxRoot], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("bash", [path.join(root, "scripts/ocr/run-worker.sh"), root], { stdio: ["pipe", "pipe", "pipe"] });
  return connectOcrWorker(child, log, fatal);
}

// Cached models on the Windows-mounted WSL filesystem can take over 90 seconds
// to load. Keep this separate from the much shorter inference watchdog.
export const OCR_STARTUP_TIMEOUT_MS = 180_000;
export function connectOcrWorker(child: ChildProcessWithoutNullStreams, log: (line: string) => void, fatal: () => void): Backend {
  logStream(child.stderr, log);
  const startedAt = Date.now();
  const fail = (reason: string) => {
    if (stopping) return;
    log(reason); backend.stop(); fatal();
  };
  let active: { id: string; resolve(value: OcrResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let buffer = "", stopping = false;
  const backend: Backend = {
    ready: false, modelLoads: 0,
    call(image, mode) {
      if (!backend.ready || active) return Promise.reject(Error("OCR worker unavailable"));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { fail("OCR inference timed out after 27000ms."); }, 27_000);
        active = { id, resolve, reject, timer };
        child.stdin.write(JSON.stringify({ id, mode, image: image.toString("base64") }) + "\n");
      });
    },
    stop() {
      if (stopping) return;
      stopping = true; backend.ready = false;
      clearTimeout(startup);
      if (active) { clearTimeout(active.timer); active.reject(Error("OCR worker stopped")); active = undefined; }
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000); timer.unref();
    },
  };
  const startup = setTimeout(() => { fail(`OCR model startup timed out after ${OCR_STARTUP_TIMEOUT_MS}ms; cached model loading did not finish.`); }, OCR_STARTUP_TIMEOUT_MS);
  child.stdout.on("data", chunk => {
    if (stopping) return;
    buffer += chunk.toString();
    if (buffer.length > 1024 * 1024) { fail("OCR protocol output exceeded its size limit."); return; }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; } // Library diagnostics never become protocol results.
      if (message.type === "ready" && message.protocol === 1 && message.engine === "paddle-mobile") {
        clearTimeout(startup); backend.ready = true; backend.modelLoads = message.modelLoads; log(`Mobile OCR ready after ${Date.now() - startedAt}ms; models retained in memory.`);
      } else if (active && message.id === active.id) {
        const job = active; active = undefined; clearTimeout(job.timer);
        if (message.error) job.reject(Error("Local OCR inference failed")); else job.resolve(message.result);
      }
    }
  });
  child.on("error", () => { fail("OCR worker process could not start."); });
  child.on("exit", (code, signal) => { fail(`OCR worker exited before shutdown (code=${code}, signal=${signal}).`); });
  child.stdin.on("error", () => { fail("OCR worker input pipe failed."); });
  return backend;
}

async function main() {
  const root = process.cwd();
  const release = acquireLock(path.join(root, ".folio-local/ocr.lock"));
  process.once("exit", release);
  const holder: { service?: Awaited<ReturnType<typeof startOcrServer>> } = {};
  async function start() {
    try { return await startOcrServer(backend, path.join(root, ".folio-local/ocr.json")); }
    catch (error) { backend.stop(); throw error; }
  }
  let exiting = false;
  const shutdown = async (code = 0) => { if (exiting) return; exiting = true; await holder.service?.stop(); release(); process.exit(code); };
  const backend = createBackend(root, () => { void shutdown(1); });
  holder.service = await start();
  const heartbeat = setInterval(() => process.send?.({ type: "folio-service-health", ready: backend.ready }), 5000);
  heartbeat.unref();
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
if (path.basename(process.argv[1] ?? "") === "server.ts") main().catch(() => { console.error("Local OCR startup failed; see OCR log or run the setup check."); process.exitCode = 1; });
