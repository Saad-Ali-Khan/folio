import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const defaultOrigin = "https://folio.saadalik11.workers.dev";
const maxResponseBytes = 512 * 1024;

async function readBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes) throw new Error("Response exceeded monitoring size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const checks = [
  {
    name: "Storefront rendering",
    path: "/",
    validate(response, body) {
      return response.status === 200 && response.headers.get("content-type")?.includes("text/html") &&
        body.includes("Books worth keeping.") &&
        !/The catalog is not ready yet|We dropped the book|Application error|data-dgst=/i.test(body);
    },
  },
  {
    name: "Availability API / database read",
    // A valid positive integer forces the normal availability query; no listing is required.
    path: "/api/books?ids=2147483647",
    validate(response, body) {
      if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) return false;
      const data = JSON.parse(body);
      return Array.isArray(data.books) && data.books.length <= 1 && data.books.every(book =>
        book.id === 2147483647 && Number.isInteger(book.stock) && book.stock >= 0 &&
        Number.isInteger(book.priceCents) && book.priceCents > 0);
    },
  },
  {
    name: "Admin API access protection",
    path: "/api/admin/books",
    validate(response) { return response.status === 401; },
  },
];

export async function monitorProduction({ origin = defaultOrigin, fetchImpl = fetch, timeoutMs = 30_000, retryDelayMs = 2000 } = {}) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Monitoring requires an HTTPS origin without credentials, path, or query.");
  }
  const results = [];
  // Sequential checks avoid unnecessary concurrent database wakeups on a small store.
  for (const check of checks) {
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const url = new URL(check.path, base);
      url.searchParams.set("folio_monitor", `${started}-${attempt}`);
      try {
        const response = await fetchImpl(url, {
          method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
          headers: { "Cache-Control": "no-cache", "User-Agent": "Folio-production-monitor/1.0" },
        });
        const body = await readBody(response);
        const passed = Boolean(check.validate(response, body));
        result = { name: check.name, passed, attempts: attempt, status: response.status, milliseconds: Date.now() - started,
          detail: passed ? "Expected response verified" : "Unexpected HTTP status or response shape" };
      } catch (error) {
        // Never print response bodies, arbitrary error messages, cookies, or secrets to public Actions logs.
        result = { name: check.name, passed: false, attempts: attempt, status: null, milliseconds: Date.now() - started,
          detail: error?.name === "TimeoutError" || error?.name === "AbortError" ? "Request timed out" : "Network, redirect, or response validation failed" };
      }
      if (result.passed || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    results.push(result);
  }
  return { checkedAt: new Date().toISOString(), origin: base.origin, passed: results.every(result => result.passed), results };
}

async function main() {
  const report = await monitorProduction({ origin: process.env.FOLIO_MONITOR_ORIGIN || defaultOrigin });
  for (const result of report.results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.status ?? "no HTTP response"}, ${result.milliseconds}ms, attempt ${result.attempts}. ${result.detail}`);
    if (result.passed && result.milliseconds > 5000) console.log(`WARNING ${result.name}: response exceeded 5 seconds; inspect latency if repeated.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = report.results.map(result => `| ${result.name} | ${result.passed ? "PASS" : "FAIL"} | ${result.status ?? "network/timeout"} | ${result.milliseconds} | ${result.attempts} |`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Folio production checks\n\n${report.checkedAt}\n\n| Check | Result | HTTP | ms | Attempts |\n|---|---|---|---|---|\n${rows}\n\nRead-only checks; account quota usage is not measured by this workflow.\n`);
  }
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Production monitor failed to initialize. Check the configured HTTPS origin."); process.exitCode = 1; });
}
