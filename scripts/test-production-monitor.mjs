import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorProduction } from "./monitor-production.mjs";

function healthy(url) {
  if (url.pathname === "/") return new Response("<html>Books worth keeping.</html>", { headers: { "content-type": "text/html" } });
  if (url.pathname === "/api/books") return Response.json({ books: [] });
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
const options = { retryDelayMs: 0 };

test("healthy empty catalog passes; all probes are read-only and availability forces an actual query", async () => {
  const report = await monitorProduction({ ...options, fetchImpl: async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.ok(url.searchParams.has("folio_monitor"));
    if (url.pathname === "/api/books") assert.equal(url.searchParams.get("ids"), "2147483647");
    return healthy(url);
  } });
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
});

test("streamed HTTP 200 catalog failure is rejected", async () => {
  const report = await monitorProduction({ ...options, fetchImpl: async url => url.pathname === "/"
    ? new Response("Books worth keeping. The catalog is not ready yet", { headers: { "content-type": "text/html" } }) : healthy(url) });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].attempts, 2);
});

test("one transient failure recovers on retry", async () => {
  let calls = 0;
  const report = await monitorProduction({ ...options, fetchImpl: async url => {
    if (calls++ === 0) throw new Error("sensitive arbitrary upstream message");
    return healthy(url);
  } });
  assert.equal(report.passed, true);
  assert.equal(report.results[0].attempts, 2);
  assert.doesNotMatch(JSON.stringify(report), /sensitive/);
});

test("database failure, malformed JSON, wrong content, redirect and exposed admin API fail", async () => {
  for (const response of [new Response("database details", { status: 500 }), new Response("not json", { headers: { "content-type": "application/json" } }), Response.json({ error: "failed" }), new Response("login", { headers: { "content-type": "text/html" } })]) {
    const report = await monitorProduction({ ...options, fetchImpl: async url => url.pathname === "/api/books" ? response.clone() : healthy(url) });
    assert.equal(report.passed, false);
  }
  const exposed = await monitorProduction({ ...options, fetchImpl: async url => url.pathname === "/api/admin/books" ? Response.json({ books: [] }) : healthy(url) });
  assert.equal(exposed.results[2].passed, false);
  const redirected = await monitorProduction({ ...options, fetchImpl: async () => { throw new TypeError("fetch failed: redirect"); } });
  assert.equal(redirected.passed, false);
});

test("timeout and oversized response fail with safe diagnostics", async () => {
  for (const fetchImpl of [async () => { throw new DOMException("private URL", "TimeoutError"); }, async () => new Response("x".repeat(600 * 1024))]) {
    const report = await monitorProduction({ ...options, fetchImpl });
    assert.equal(report.passed, false);
    assert.doesNotMatch(JSON.stringify(report), /private URL/);
  }
  await assert.rejects(monitorProduction({ origin: "https://secret:password@example.com" }), /without credentials/);
});
