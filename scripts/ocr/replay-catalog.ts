import { readFileSync, writeFileSync } from "node:fs";
import { lookupCoverMetadata } from "../../lib/import-metadata";
import type { CoverLine } from "../../lib/cover-ocr";

// Offline matcher comparison: exact recorded search queries only. Never imports stock.
const read = (name: string) => JSON.parse(readFileSync(`.folio-ocr/${name}.json`, "utf8"));
const normalize = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
type Sample = { id: string; group: string; expectedTitle: string; expectedAuthor: string;
  expectedTitleAliases?: string[]; expectedAuthorAliases?: string[] };
type Trace = { sample: string; engine: string; query?: string; response?: unknown; selected?: unknown };
const traces: Trace[] = read("catalog-trace");
const cases: Sample[] = read("cases");
async function main() {
const originalFetch = globalThis.fetch;
const rows = [];
try {
  for (const file of ["tesseract", "paddle"]) {
    const engine = read(file) as { engine: string; cases: { id: string; lines: CoverLine[] }[] };
    for (const run of engine.cases) {
      const sample = cases.find(sample => sample.id === run.id)!;
      const records = traces.filter(trace => trace.sample === run.id && trace.engine === engine.engine);
      let authorFixture = false;
      const missing: string[] = [];
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname === "/authors/OL18404A.json") {
          // The old trace did not record author responses. This identity is a
          // separately labelled test fixture, excluded from captured-only totals.
          authorFixture = true;
          return Response.json({ name: "Ὅμηρος", alternate_names: ["Homer"] });
        }
        const query = url.searchParams.get("q");
        const captured = url.pathname === "/search.json" && records.find(record => record.query === query && record.response);
        if (captured) return Response.json(captured.response);
        missing.push(url.pathname === "/search.json" ? query ?? url.pathname : url.pathname);
        throw new Error("No recorded response; network is disabled");
      };
      let selected, error;
      try { selected = await lookupCoverMetadata(run.lines, true); }
      catch (cause) { error = String(cause); }
      const correct = (value: unknown) => {
        const match = value as { title: string; author: string } | null;
        return match && [sample.expectedTitle, ...(sample.expectedTitleAliases ?? [])].some(title => normalize(title) === normalize(match.title)) &&
          [sample.expectedAuthor, ...(sample.expectedAuthorAliases ?? [])].some(author => normalize(author) === normalize(match.author));
      };
      const status = (value: unknown) => !value ? "no_match" : correct(value) ? "correct" : "WRONG_MATCH";
      rows.push({ sample: run.id, engine: file, group: sample.group,
        before: status(records.find(record => "selected" in record)?.selected),
        after: missing.length ? "missing_fixture" : error ? "error" : status(selected), title: selected?.title,
        authorFixture, missing, error });
    }
  }
} finally { globalThis.fetch = originalFetch; }
writeFileSync(".folio-ocr/catalog-replay.json", JSON.stringify(rows, null, 2));
console.table(rows.map(({ missing, error, ...row }) => ({ ...row, missing: missing.length, error })));
for (const engine of ["tesseract", "paddle"]) {
  const captured = rows.filter(row => row.engine === engine && !row.authorFixture && !row.missing.length);
  console.log(engine, "captured-only", { cases: captured.length,
    before: captured.filter(row => row.before === "correct").length,
    after: captured.filter(row => row.after === "correct").length,
    wrong: captured.filter(row => row.after === "WRONG_MATCH").length });
}
console.log("Offline captured-response replay only; author fixtures and missing responses are labelled. No OCR, network, messages or inventory writes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
