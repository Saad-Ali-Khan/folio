import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { acquireLock, createLog, LocalService } from "./local-runtime";
import { getDb } from "../lib/db";
import { createCoverCleanupScheduler } from "../lib/cover-cleanup-scheduler";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, ".folio-local");
const controlFile = path.join(runtime, "control.json");
const command = process.argv[2] ?? "start";
const secret = process.env.INVENTORY_DISCORD_SECRET?.trim();
const port = 3000;

async function control(action: "status" | "stop") {
  const state = JSON.parse(readFileSync(controlFile, "utf8"));
  const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
    method: action === "stop" ? "POST" : "GET", headers: { authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Local service control returned ${response.status}.`);
  return response.json();
}

async function occupied() {
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  });
}

async function run() {
  if (command === "status" || command === "stop") {
    console.log(JSON.stringify(await control(command), null, 2));
    return;
  }
  if (command === "up") {
    try { console.log(JSON.stringify(await control("status"), null, 2)); return; } catch { /* Not running. */ }
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", "--import", "tsx", fileURLToPath(import.meta.url), "start"], {
      cwd: root, detached: true, windowsHide: true, stdio: "ignore",
    });
    child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { console.log(JSON.stringify(await control("status"), null, 2)); return; } catch { /* Booting. */ }
    }
    throw new Error("Launcher status could not be reached. Run npm run local:status first; if offline, use npm run local:start to see the error.");
  }
  if (command !== "start") throw new Error("Use start, up, status, or stop.");
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID", "INVENTORY_DISCORD_SECRET", "INVENTORY_DISCORD_PIN", "DATABASE_URL"]) {
    if (!process.env[key]?.trim()) throw new Error(`Missing ${key} in local environment.`);
  }
  const configured = new URL(process.env.INVENTORY_API_URL || "http://localhost:3000");
  if (!["localhost", "127.0.0.1"].includes(configured.hostname) || configured.protocol !== "http:" || configured.port !== String(port) || configured.pathname !== "/" || configured.search || configured.username || configured.password) {
    throw new Error("The local launcher requires INVENTORY_API_URL=http://127.0.0.1:3000.");
  }
  const release = acquireLock(path.join(runtime, "supervisor.lock"));
  process.once("exit", release);
  if (await occupied()) throw new Error("Port 3000 is already in use. Stop the existing local server first; it has not been changed.");
  const secrets = Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PIN|PASSWORD|DATABASE_URL|ACCESS_KEY/i.test(key)).map(([, value]) => value ?? "");
  const logger = (name: string) => createLog(path.join(runtime, "logs", `${name}.log`), secrets);
  const log = logger("supervisor");
  const env = { ...process.env, INVENTORY_API_URL: "http://127.0.0.1:3000" };
  const api = new LocalService("api", [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], root, env, logger("api"));
  const bot = new LocalService("bot", ["--import", "tsx", path.join(root, "scripts/discord-bot.ts")], root, env, logger("bot"));
  const cleanup = process.env.PHOTO_STORAGE === "r2" ? createCoverCleanupScheduler(getDb, log) : undefined;
  bot.onMessage = message => {
    if(message && typeof message === "object" && "type" in message && message.type === "folio-cover-cleanup" && "at" in message && typeof message.at === "number") cleanup?.schedule(message.at);
  };
  let stopping = false;
  let failures = 0;
  let readySince = Date.now();
  let botUnreadySince = Date.now();
  let health: unknown = { ready: false, state: "starting" };
  const token = randomBytes(32).toString("hex");
  const status = () => ({ localOnly: true, api: health, bot: { running: Boolean(bot.child), ready: bot.ready, blocked: bot.blocked, restarts: bot.restarts }, apiRestarts: api.restarts, logs: path.join(runtime, "logs") });
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/status") { res.end(JSON.stringify(status())); return; }
    if (req.method === "POST" && req.url === "/stop") { res.end(JSON.stringify({ stopping: true })); void shutdown(); return; }
    if (req.method === "POST" && req.url === "/cover-cleanup") {
      void (async()=>{
        let body="";
        for await(const chunk of req){body+=chunk.toString();if(body.length>256){res.writeHead(413).end();return;}}
        const input=JSON.parse(body);
        if(typeof input.at!=="number"||!Number.isFinite(input.at)){res.writeHead(400).end();return;}
        cleanup?.schedule(input.at);res.end(JSON.stringify({scheduled:Boolean(cleanup)}));
      })().catch(()=>{if(!res.headersSent)res.writeHead(400);res.end();});
      return;
    }
    res.writeHead(404).end();
  });
  server.on("error", error => { log(error.message); void shutdown(); });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    cleanup?.stop();
    clearInterval(interval);
    try { await bot.stop(); await api.stop(); }
    catch (error) { log(String(error)); process.exitCode = 1; }
    server.close();
    try { unlinkSync(controlFile); } catch { /* Already removed. */ }
    release();
    log("Local services stopped.");
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  let probing = false;
  async function probe() {
    if (probing || stopping) return;
    probing = true;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/local/health`, { headers: { "x-inventory-secret": secret! }, signal: AbortSignal.timeout(10_000), redirect: "error" });
      const body = await response.json();
      if (stopping) return;
      if (!response.ok || body.service !== "folio-local-inventory" || !body.ready) throw new Error("API/OCR readiness failed.");
      health = body;
      api.ready = true;
      failures = 0;
      readySince = Date.now();
      bot.start();
      if (bot.ready) botUnreadySince = Date.now();
      if (bot.child && (Date.now() - bot.lastMessageAt > 90_000 || !bot.ready && Date.now() - botUnreadySince > 90_000)) {
        log("Discord heartbeat unavailable for 90 seconds; restarting bot.");
        await bot.stop();
        botUnreadySince = Date.now();
        if (!stopping) bot.start();
      }
    } catch {
      if (stopping) return;
      health = { ready: false, state: "API unavailable or OCR/configuration not ready" };
      api.ready = false;
      failures++;
      if (failures >= 3) {
        await bot.stop();
        botUnreadySince = Date.now();
      }
      if (failures >= 3 && Date.now() - readySince > 120_000) {
        log("Local API unhealthy after startup grace; restarting.");
        await api.stop();
        readySince = Date.now();
        failures = 0;
        if (!stopping) api.start();
      }
    } finally { probing = false; }
  }
  const interval = setInterval(() => { void probe().catch(error => { log(String(error)); void shutdown(); }); }, 15_000);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local control endpoint.");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(controlFile, JSON.stringify({ port: address.port, token }), { mode: 0o600 });
  api.start();
  void cleanup?.start();
  log("Supervisor started. Routine probes do not access Neon.");
  console.log("Local services starting. Use npm run local:status; logs are in .folio-local/logs.");
  void probe().catch(error => { log(String(error)); void shutdown(); });
}

run().catch(error => {
  const reason = error.cause?.code ? ` (${error.cause.code})` : "";
  console.error(`${error.message}${reason}`);
  process.exitCode = 1;
});
