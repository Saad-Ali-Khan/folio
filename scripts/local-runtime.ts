import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export function localControlDenied(error: unknown): boolean {
  let current=error;
  for(let depth=0;depth<6&&current&&typeof current==='object';depth++){
    if('code' in current && ['EACCES','EPERM','LOCAL_CONTROL_DENIED'].includes(String(current.code)))return true;
    current='cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Recover metadata only after refusal/missing control and proof the owner is dead. */
export function recoverStoppedControl(controlFile: string, lockFile: string, error: unknown,
  probe: (pid: number) => void = pid => process.kill(pid, 0)): boolean {
  if (localControlDenied(error)) return false;
  let current = error, offline = false;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if ("code" in current && ["ECONNREFUSED", "ENOENT"].includes(String(current.code))) offline = true;
    current = "cause" in current ? current.cause : undefined;
  }
  if (!offline) return false;
  if (!existsSync(controlFile)) {
    if (!existsSync(lockFile)) return true;
    try {
      const snapshot = readFileSync(lockFile, "utf8"), owner = JSON.parse(snapshot);
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.nonce) return false;
      try { probe(owner.pid); return false; }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      return !existsSync(controlFile) && readFileSync(lockFile, "utf8") === snapshot;
    } catch { return false; }
  }
  try {
    const control = readFileSync(controlFile, "utf8"), lock = readFileSync(lockFile, "utf8");
    const state = JSON.parse(control), owner = JSON.parse(lock);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.nonce ||
      state.pid !== undefined && state.pid !== owner.pid || state.nonce !== undefined && state.nonce !== owner.nonce) return false;
    try { probe(owner.pid); return false; }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    if (readFileSync(controlFile, "utf8") !== control || readFileSync(lockFile, "utf8") !== lock) return false;
    unlinkSync(controlFile); // acquireLock independently recovers the dead lock at startup.
    return true;
  } catch { return false; }
}

export async function waitForLocalStop(controlFile: string, lockFile: string,
  control: string, lock: string | undefined, timeout = 30_000) {
  const read = (file: string) => {
    try { return readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const currentControl = read(controlFile);
    const currentLock = read(lockFile);
    if (currentControl === undefined && currentLock === undefined) return;
    if (currentControl !== undefined && currentControl !== control || currentLock !== undefined && currentLock !== lock) {
      throw Error("Local supervisor ownership changed during shutdown; inspect status before restarting.");
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("Local supervisor is still shutting down; no replacement was launched.");
}

export function setLocalPaused(file: string, paused: boolean) {
  if(paused){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'Paused by local:stop. Run local:up to resume.\n',{mode:0o600});}
  else try{unlinkSync(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

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
      if (message && typeof message === "object" && "type" in message && ["folio-bot-health", "folio-service-health"].includes(String(message.type))) {
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
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
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
