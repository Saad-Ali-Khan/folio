import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export function acquireLock(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      closeSync(fd);
      return () => {
        try { if (JSON.parse(readFileSync(file, "utf8")).nonce === nonce) unlinkSync(file); } catch { /* Already removed. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try { pid = JSON.parse(readFileSync(file, "utf8")).pid; } catch { throw new Error("Unreadable service lock; inspect it before removing it."); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid service lock; inspect it before removing it.");
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(file); continue; }
      }
      throw new Error("This service is already running (or its process cannot be inspected).");
    }
  }
  throw new Error("Could not acquire the service lock.");
}

export function createLog(file: string, secrets: string[], maxBytes = 5 * 1024 * 1024) {
  mkdirSync(path.dirname(file), { recursive: true });
  const privateValues = [...new Set(secrets.filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  return (input: string) => {
    let safe = input.replace(/\u001b\[[0-9;]*m/g, "");
    for (const value of privateValues) safe = safe.split(value).join("[redacted]");
    safe = safe.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL redacted]");
    const line = `${new Date().toISOString()} ${safe}\n`;
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
      if (existsSync(`${file}.2`)) unlinkSync(`${file}.2`);
      if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`);
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, line, { mode: 0o600 });
  };
}

// Decode complete lines so a token split across stdout chunks cannot evade redaction.
export function logStream(stream: NodeJS.ReadableStream, log: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  stream.on("data", (chunk: Buffer) => {
    const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!dropping) log(line.length > 16_384 ? "[oversized log line omitted]" : line);
      dropping = false;
    }
    if (pending.length > 16_384) { pending = ""; dropping = true; }
  });
  stream.on("end", () => { if (pending && !dropping) log(pending + decoder.end()); });
}

export class LocalService {
  onMessage?: (message: unknown) => void;
  child?: ChildProcess;
  restarts = 0;
  failures = 0;
  lastMessageAt = 0;
  ready = false;
  blocked = false;
  private enabled = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly name: string, private args: string[], private cwd: string,
    private env: NodeJS.ProcessEnv, private log: (line: string) => void, private baseDelay = 1000) {}

  start() {
    this.enabled = true;
    if (this.child || this.timer || this.blocked) return;
    this.ready = false;
    this.lastMessageAt = Date.now();
    const started = Date.now();
    const child = spawn(process.execPath, this.args, { cwd: this.cwd, env: this.env, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"] });
    this.child = child;
    this.log(`${this.name}: started process ${child.pid ?? "pending"}`);
    logStream(child.stdout!, this.log);
    logStream(child.stderr!, this.log);
    child.on("message", message => {
      this.onMessage?.(message);
      if (message && typeof message === "object" && "type" in message && message.type === "folio-bot-health") {
        this.lastMessageAt = Date.now();
        this.ready = "ready" in message && message.ready === true;
      }
    });
    child.on("error", error => this.log(`${this.name}: ${error.message}`));
    child.once("exit", code => {
      this.child = undefined;
      this.ready = false;
      if (code === 78) this.blocked = true;
      if (!this.enabled || this.blocked) return;
      if (Date.now() - started > 120_000) this.failures = 0;
      const delay = Math.min(60_000, this.baseDelay * 2 ** Math.min(this.failures++, 6));
      this.restarts++;
      this.log(`${this.name}: exited (${code}); retry in ${delay}ms`);
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
    });
  }

  async stop() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    // Kill only a child created by this instance, including Next/OCR descendants.
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      if (result.status !== 0 && child.exitCode === null) child.kill();
    } else {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    await Promise.race([exited, new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Could not stop ${this.name}; inspect its process before restarting.`)), 8000);
      exited.then(() => { clearTimeout(timer); resolve(); });
    })]);
  }
}
