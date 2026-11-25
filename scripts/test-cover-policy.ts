import assert from "node:assert/strict";
import { recognizeCoverStages } from "../lib/cover-recognition";
import { CatalogUnavailable } from "../lib/import-metadata";

async function main() {
  const meta = { title: "Verified Book", author: "Verified Author", isbn: null, coverUrl: null };
  const lines = (text: string) => [{ text, height: .1, top: .1, confidence: 95 }];
  const controller = new AbortController();
  let calls: string[] = [];
  let mobileError = false, catalogError = false;
  let winner = "mobile";
  const deps = {
    mobile: async () => { calls.push("mobile"); if (mobileError) throw Error("offline"); return lines("mobile"); },
    tesseract: async (_image: Buffer, focused?: boolean) => { calls.push(focused ? "focused" : "initial"); return lines(focused ? "focused" : "initial"); },
    crops: async () => { calls.push("crops"); return lines("crops"); },
    lookup: async (scan: { text: string }[]) => {
      calls.push("lookup:" + scan.map(line => line.text).join("+"));
      if (catalogError) throw new CatalogUnavailable("catalog offline");
      if (controller.signal.aborted) return meta;
      return scan.some(line => line.text === winner) ? meta : null;
    },
  };
  const run = () => recognizeCoverStages(Buffer.alloc(0), true, controller.signal, deps);
  assert.equal((await run()).stage, "mobile");
  assert.deepEqual(calls, ["mobile", "lookup:mobile"], "success must not be overwritten by further scans");
  calls = []; winner = "focused";
  assert.equal((await run()).stage, "tesseract");
  assert(!calls.includes("crops")); assert(calls.includes("lookup:initial+focused"));
  calls = []; winner = "crops";
  assert.equal((await run()).stage, "crops");
  assert.equal(calls.filter(call => call === "crops").length, 1);
  winner = "missing";
  const unresolved=await run();
  assert.equal(unresolved.metadata, null, "unresolved scans cannot invent metadata");
  assert(unresolved.suggestionLines?.some(line=>line.text==="mobile"),"partial mobile evidence remains available after later OCR fails");
  calls = []; mobileError = true; winner = "focused";
  assert.equal((await run()).stage, "tesseract");
  assert(!calls.includes("crops"), "offline worker cannot be used for crop fallback");
  calls = []; mobileError = false; catalogError = true;
  await assert.rejects(run(), CatalogUnavailable);
  assert(!calls.includes("initial"), "catalog failure is not evidence of bad OCR");
  catalogError = false; controller.abort(); calls = [];
  await assert.rejects(run()); assert.deepEqual(calls, []);
  const late = new AbortController();
  await assert.rejects(recognizeCoverStages(Buffer.alloc(0), true, late.signal, { ...deps,
    lookup: async scan => { if (scan.some(line => line.text === "crops")) { late.abort(); return meta; } return null; },
  }), "a catalog result arriving after crop cancellation cannot be accepted");
  console.log("PASS mobile early exit, Tesseract/crop fallback, unresolved retention boundary, offline worker, catalog outages and cancellation. No network or inventory writes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
