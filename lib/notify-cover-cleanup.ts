import { readFile } from "node:fs/promises";
import path from "node:path";

/** Notify the local supervisor before replying; Discord may lose its response. */
export async function notifyCoverCleanup(expiresAt?: string) {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return;
  try {
    const state=JSON.parse(await readFile(path.join(process.cwd(),".folio-local/control.json"),"utf8"));
    if(!Number.isInteger(state.port)||state.port<1||state.port>65535||!/^[a-f0-9]{64}$/.test(state.token))return;
    await fetch(`http://127.0.0.1:${state.port}/cover-cleanup`,{method:"POST",headers:{authorization:`Bearer ${state.token}`,"content-type":"application/json"},body:JSON.stringify({at:Date.parse(expiresAt)}),signal:AbortSignal.timeout(2000),redirect:"error"});
  } catch { /* Bot IPC and supervisor startup reconciliation are fallback paths. */ }
}
