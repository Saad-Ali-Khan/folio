import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { recoverStoppedControl, waitForLocalStop } from "./local-runtime";

async function main() {
  const root = process.cwd(), folder = mkdtempSync(path.join(root, ".folio-local-test-"));
  const control = path.join(folder, "control.json"), lock = path.join(folder, "supervisor.lock");
  const offline = new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
  const dead = () => { throw Object.assign(Error("dead"), { code: "ESRCH" }); };
  const denied = () => { throw Object.assign(Error("denied"), { code: "EPERM" }); };
  const owner = JSON.stringify({ pid: 12345, nonce: "owner" });
  const state = JSON.stringify({ port: 1234, token: "test", pid: 12345, nonce: "owner" });
  try {
    writeFileSync(lock, owner); writeFileSync(control, state);
    assert.equal(recoverStoppedControl(control, lock, offline, () => {}), false, "live owner cannot be replaced");
    assert.equal(recoverStoppedControl(control, lock, offline, denied), false, "permission denial is not proof of death");
    assert.equal(recoverStoppedControl(control, lock, { code: "EACCES" }, dead), false);
    assert.equal(recoverStoppedControl(control, lock, Error("timeout"), dead), false);
    assert.equal(recoverStoppedControl(control, lock, offline, dead), true);
    assert.equal(existsSync(control), false); assert.equal(readFileSync(lock, "utf8"), owner, "only stale control is removed");
    assert.equal(recoverStoppedControl(control, lock, { code: "ENOENT" }, () => {}), false, "a live owner may still be starting");
    assert.equal(recoverStoppedControl(control, lock, { code: "ENOENT" }, dead), true);
    writeFileSync(control, state);
    assert.equal(recoverStoppedControl(control, lock, offline, () => { writeFileSync(control, "replacement"); dead(); }), false,
      "a replacement record is never deleted");
    writeFileSync(control, state);
    const waiting = waitForLocalStop(control, lock, state, owner, 2000);
    let completed = false; waiting.then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(completed, false, "acknowledgement is not complete shutdown");
    unlinkSync(control); unlinkSync(lock); await waiting;
    await waitForLocalStop(control, lock, state, undefined, 100);
    writeFileSync(control, "new owner");
    await assert.rejects(waitForLocalStop(control, lock, state, undefined, 100), /ownership changed/);
    console.log("PASS stale owner recovery, live/denied/starting owner protection, record-replacement race, idempotent stop and shutdown completion barrier.");
  } finally {
    assert(path.resolve(folder).startsWith(path.join(root, ".folio-local-test-")));
    rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
