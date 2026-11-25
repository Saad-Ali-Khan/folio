import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { acquireLock, createLog, LocalService, logStream, localControlDenied, setLocalPaused } from "./local-runtime";
import { GET as health } from "../app/api/local/health/route";

const temp = mkdtempSync(path.join(process.cwd(), ".folio-local-test-"));
async function until(check: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for service lifecycle.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
let service: LocalService | undefined;
try {
  assert.equal(localControlDenied(new Error('fetch failed',{cause:{code:'EACCES'}})),true);
  assert.equal(localControlDenied({code:'EPERM'}),true);
  assert.equal(localControlDenied({code:'LOCAL_CONTROL_DENIED'}),true);
  assert.equal(localControlDenied(new Error('fetch failed',{cause:{code:'ECONNREFUSED'}})),false);
  console.log('PASS access-denied control checks cannot be mistaken for an offline supervisor');
  const pausedFile=path.join(temp,'paused');setLocalPaused(pausedFile,true);assert.ok(existsSync(pausedFile));setLocalPaused(pausedFile,false);setLocalPaused(pausedFile,false);assert.equal(existsSync(pausedFile),false);
  console.log('PASS explicit stop pause persists and explicit up resumes idempotently');
  const values = { INVENTORY_DISCORD_SECRET: "test-health-secret", DISCORD_CHANNEL_ID: "test-channel", INVENTORY_DISCORD_PIN: "123456", DATABASE_URL: "invalid-do-not-connect" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    assert.equal((await health(new Request("http://localhost/api/local/health"))).status, 403);
    const response = await health(new Request("http://localhost/api/local/health", { headers: { "x-inventory-secret": values.INVENTORY_DISCORD_SECRET } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).database, "not probed");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  console.log("PASS health requires authentication and checks OCR assets without connecting to the database");
  const lock = path.join(temp, "test.lock");
  const release = acquireLock(lock);
  assert.throws(() => acquireLock(lock), /already running/);
  release();
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, nonce: "stale" }));
  acquireLock(lock)();
  console.log("PASS duplicate process rejected and stale process lock recovered");

  const file = path.join(temp, "service.log");
  const log = createLog(file, ["secret-token-123456", "840071"], 200);
  const stream = new PassThrough();
  logStream(stream, log);
  stream.write("token=secret-token-");
  stream.write("123456 pin=840071\n");
  stream.end();
  assert.match(readFileSync(file, "utf8"), /token=\[redacted\] pin=\[redacted\]/);
  for (let i = 0; i < 40; i++) log(`line ${i} postgres://private:password@database/db`);
  const logs = readdirSync(temp).filter(name => name.startsWith("service.log"));
  assert.equal(logs.length, 3);
  for (const name of logs) assert.doesNotMatch(readFileSync(path.join(temp, name), "utf8"), /password|secret-token|840071/);
  console.log("PASS split secrets redacted and log rotation bounded to three files");

  const marker = path.join(temp, "crashed");
  const fixture = `const fs=require('node:fs'); if(!fs.existsSync(process.env.FOLIO_TEST_MARKER)){fs.writeFileSync(process.env.FOLIO_TEST_MARKER,'1');process.exit(1)}; const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.env.FOLIO_TEST_MARKER,String(child.pid));setInterval(()=>process.send({type:'folio-bot-health',ready:true}),30);`;
  service = new LocalService("fixture", ["-e", fixture], temp, { ...process.env, FOLIO_TEST_MARKER: marker }, log, 50);
  service.start();
  service.start();
  await until(() => service!.ready && service!.restarts === 1);
  const pid = service.child!.pid!;
  const descendantPid = Number(readFileSync(marker, "utf8"));
  await service.stop();
  assert.equal(service.child, undefined);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(service.child, undefined);
  assert.throws(() => process.kill(pid, 0));
  assert.throws(() => process.kill(descendantPid, 0));
  console.log("PASS crashed child restarts, heartbeat reaches ready, stop removes child tree without restarting");

  service = new LocalService("duplicate", ["-e", "process.exit(78)"], temp, process.env, log, 50);
  service.start();
  await until(() => service!.blocked);
  assert.equal(service.restarts, 0);
  service.start();
  assert.equal(service.child, undefined);
  await service.stop();
  console.log("PASS duplicate bot exit blocks repeated login attempts");
} finally {
  await service?.stop();
  rmSync(temp, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
