import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readCoverLines, type CoverLine } from "../../lib/cover-ocr";
import { lookupCoverMetadata } from "../../lib/import-metadata";
import { readingOrder } from "./geometry";

type Source = { id: string; image: string; expectedTitle: string; expectedAuthor: string;
  group?: string; source?: string; labelStatus?: string; expectedTitleAliases?: string[]; expectedAuthorAliases?: string[]; expectedVisibleAuthor?: string; reviewedSha256?: string };
type Case = Source & { width: number; height: number; sha256: string };
type Stage = { name: string; ocrMs: number; lines: CoverLine[]; error?: string };
type Run = { id: string; ocrMs: number; lines: CoverLine[]; error?: string; extraOcrMs?: number; stages?: Stage[] };
type Results = { datasetHash: string; cases: Run[]; loadMs?: number; peakRssMiB?: number; engine: string; complete?: boolean };
const root = path.resolve(".folio-ocr");
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const load = <T>(name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8")) as T;

async function prepare() {
  mkdirSync(path.join(root, "inputs"), { recursive: true });
  const title = "The Greatest Minds and Ideas of All Time", author = "Will Durant";
  const sources: Source[] = [
    { id: "durant-discord", image: ".folio-ocr/seed-inputs/durant-discord.png", expectedTitle: title, expectedAuthor: author },
    { id: "durant-clipboard", image: ".folio-ocr/seed-inputs/durant-clipboard.png", expectedTitle: title, expectedAuthor: author },
    { id: "little-prince-upload", image: ".folio-ocr/seed-inputs/little-prince-upload.png", expectedTitle: "The Little Prince", expectedAuthor: "Antoine de Saint-Exupéry" },
  ].filter(source => existsSync(source.image));
  for (const source of sources) { source.group = "user-upload"; source.labelStatus = "verified"; }
  if (existsSync(path.join(root, "collected-cases.json"))) sources.push(...load<Source[]>("collected-cases.json"));
  if (existsSync(path.join(root, "custom-cases.json"))) sources.push(...load<Source[]>("custom-cases.json"));
  if (!sources.length || sources.length > 100) throw Error("Provide 1–100 labelled local photos in .folio-ocr/custom-cases.json.");
  const ids = new Set<string>();
  const cases: Case[] = [];
  const hashes = new Set<string>(), duplicates: string[] = [];
  for (const source of sources) {
    if (!/^[a-z0-9-]{1,70}$/.test(source.id) || ids.has(source.id) || !source.expectedTitle || !source.expectedAuthor) {
      throw Error("Cases need unique simple IDs and expected titles/authors.");
    }
    ids.add(source.id);
    const input = readFileSync(source.image);
    if (source.reviewedSha256 && hash(input) !== source.reviewedSha256) throw Error(`Reviewed image changed: ${source.id}`);
    if (input.length > 12 * 1024 * 1024) throw Error(`Photo ${source.id} exceeds 12MB.`);
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: 1600, height: 1600, fit: "inside" }).flatten({ background: "white" }).png().toBuffer({ resolveWithObject: true });
    const image = `inputs/${source.id}.png`;
    const sha256 = hash(data);
    if (hashes.has(sha256)) { duplicates.push(source.id); continue; }
    hashes.add(sha256);
    writeFileSync(path.join(root, image), data);
    cases.push({ ...source, image, width: info.width, height: info.height, sha256 });
  }
  save("cases.json", cases);
  save("duplicate-images.json", duplicates);
  const result: Results = { engine: "Current Tesseract bot path: initial + focused", datasetHash: hash(readFileSync(path.join(root, "cases.json"))), cases: [] };
  for (const sample of cases) {
    const started = performance.now();
    try {
      const image = readFileSync(path.join(root, sample.image));
      const lines = [...await readCoverLines(image), ...await readCoverLines(image, true)];
      result.cases.push({ id: sample.id, lines, ocrMs: Math.round(performance.now() - started) });
    } catch (error) {
      result.cases.push({ id: sample.id, lines: [], ocrMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "OCR failed" });
    }
    save("tesseract.json", result);
    console.log(`Tesseract completed ${sample.id}: ${result.cases.at(-1)!.ocrMs}ms`);
  }
  console.log(`Prepared ${cases.length} private local samples. No database writes or Discord messages.`);
}

function wordCoverage(expected: string, lines: CoverLine[]) {
  const tokens = normalize(expected).split(" ");
  const observed = lines.filter(line => (line.confidence ?? 0) >= 65).map(line => normalize(line.text)).join(" ").split(" ");
  // This is text coverage, not a correctness/confidence score. Preserve raw output for review.
  return Math.round(100 * tokens.filter(token => observed.includes(token)).length / tokens.length);
}

async function report() {
  const cases = load<Case[]>("cases.json"), datasetHash = hash(readFileSync(path.join(root, "cases.json")));
  const engines = [load<Results>("tesseract.json"), load<Results>("paddle.json")];
  const stronger = process.argv.includes("--stronger");
  const geometry = process.argv.includes("--geometry");
  if (stronger && geometry) throw Error("Choose one report profile");
  if (stronger) engines.push(load<Results>("paddle-stronger.json"));
  if (geometry) engines.push({ ...engines[1], engine: "PaddleOCR mobile + row order only / no extra OCR",
    cases: engines[1].cases.map(run => ({ ...run, lines: readingOrder(run.lines) })) }, load<Results>("paddle-geometry.json"));
  if (geometry) engines.push({ ...engines[3], engine: "Fallback policy: mobile then Tesseract then crop trial",
    cases: engines[1].cases.map(mobile => {
      const tess = engines[0].cases.find(run => run.id === mobile.id)!;
      const crop = engines[3].cases.find(run => run.id === mobile.id)!;
      if (!tess || !crop) throw Error(`Missing fallback-stage result: ${mobile.id}`);
      return { ...mobile, stages: [{ ...mobile, name: "mobile" }, { ...tess, name: "tesseract" },
        { ...crop, name: "crops", ocrMs: crop.extraOcrMs ?? crop.ocrMs }] };
    }) });
  const outputName = (name: string) => stronger || geometry ? name.replace(".json", geometry ? "-geometry.json" : "-stronger.json") : name;
  const rows = [];
  const catalogTrace: unknown[] = [];
  const lookups = new Map<string, ReturnType<typeof lookupCoverMetadata>>();
  const evaluate = (lines: CoverLine[]) => {
    const key = JSON.stringify(lines);
    let pending = lookups.get(key);
    if (!pending) { pending = lookupCoverMetadata(lines, true); lookups.set(key, pending); }
    return pending;
  };
  let nextCatalogRequestAt = 0;
  for (const engine of engines) {
    console.log(`Comparing catalog results: ${engine.engine}`);
    if (engine.complete === false) throw Error("PaddleOCR did not complete; partial results cannot establish a winner.");
    if (engine.datasetHash !== datasetHash) throw Error("The results belong to different datasets; rerun the trial.");
    for (const sample of cases) {
      if (hash(readFileSync(path.join(root, sample.image))) !== sample.sha256) throw Error(`Input changed: ${sample.id}`);
      const savedRun = engine.cases.find(run => run.id === sample.id);
      if (!savedRun) throw Error(`Missing result: ${sample.id}`);
      let run = savedRun;
      let measuredOcrMs = run.ocrMs;
      let stageUsed: string | undefined;
      let catalog: string = run.error ? "ocr_error" : "no_match";
      let matchedTitle: string | undefined;
      if (!run.error || savedRun.stages) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          if (url.hostname === "openlibrary.org") {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, nextCatalogRequestAt - Date.now())));
            nextCatalogRequestAt = Date.now() + 1100;
          }
          const response = await originalFetch(input, init);
          if (url.hostname === "openlibrary.org" && response.ok) {
            catalogTrace.push({ sample: sample.id, engine: engine.engine, query: url.searchParams.get("q"),
              pathname: url.pathname,
              response: await response.clone().json() });
          }
          return response;
        };
        try {
          let match;
          if (savedRun.stages) {
            measuredOcrMs = 0;
            for (const stage of savedRun.stages) {
              measuredOcrMs += stage.ocrMs;
              stageUsed = stage.name;
              run = { ...savedRun, lines: stage.lines, error: stage.error };
              if (stage.error) continue;
              match = await evaluate(stage.lines);
              if (match) break;
            }
          } else match = await evaluate(run.lines);
          catalogTrace.push({ sample: sample.id, engine: engine.engine, selected: match });
          matchedTitle = match?.title;
          if (!match) catalog = run.error ? "ocr_error" : "no_match";
          if (match) catalog = [sample.expectedTitle, ...(sample.expectedTitleAliases ?? [])].some(title => normalize(match.title) === normalize(title)) &&
            [sample.expectedAuthor, ...(sample.expectedAuthorAliases ?? [])].some(author => normalize(match.author) === normalize(author)) ? "correct" : "WRONG_MATCH";
        } catch { catalog = "catalog_unavailable"; }
        finally { globalThis.fetch = originalFetch; }
      }
      rows.push({ sample: sample.id, group: sample.group ?? "unclassified", labelStatus: sample.labelStatus ?? "pending-visual-review", engine: engine.engine, ocrMs: measuredOcrMs, stageUsed,
        extraOcrMs: run.extraOcrMs,
        titleWordCoverage: wordCoverage(sample.expectedTitle, run.lines), authorWordCoverage: wordCoverage(sample.expectedVisibleAuthor ?? sample.expectedAuthor, run.lines),
        catalog, matchedTitle, error: run.error });
    }
  }
  save(outputName("comparison.json"), { generatedAt: new Date().toISOString(), datasetHash, rows, paddleLoadMs: engines[1].loadMs,
    engines: engines.map(({ engine, loadMs, peakRssMiB }) => ({ engine, loadMs, peakRssMiB })),
    paddlePeakRssMiB: engines[1].peakRssMiB,
    distinctTitles: new Set(cases.map(sample => normalize(sample.expectedTitle))).size,
    limitations: "User uploads, real web photos and clean covers are separate cohorts. Pending visual labels are provisional and must not count toward verified accuracy. Multiple images of one book are not independent titles. Word coverage is not accuracy. Engine confidence scales differ. Tesseract timing includes per-call worker startup; Paddle model startup is separate. No benchmark result activates an engine." });
  save(outputName("catalog-trace.json"), catalogTrace);
  console.table(rows);
  const groups = [];
  for (const engine of engines) for (const group of new Set(rows.map(row => row.group))) {
    const cohort = rows.filter(row => row.engine === engine.engine && row.group === group);
    const verified = cohort.filter(row => row.labelStatus === "verified");
    groups.push({ engine: engine.engine, group, images: cohort.length, verified: verified.length,
      correct: verified.filter(row => row.catalog === "correct").length, wrong: verified.filter(row => row.catalog === "WRONG_MATCH").length,
      noMatch: verified.filter(row => row.catalog === "no_match").length, outages: verified.filter(row => row.catalog === "catalog_unavailable").length });
  }
  save(outputName("group-summary.json"), groups);
  console.table(groups);
  console.log(`Paddle model load: ${engines[1].loadMs}ms. Private report: .folio-ocr/${outputName("comparison.json")}`);
  console.log(`Paddle process peak resident memory: ${engines[1].peakRssMiB ?? "not measured"} MiB (excludes other processes).`);
  if (stronger) console.log(`Stronger recognizer: load ${engines[2].loadMs}ms; peak RSS ${engines[2].peakRssMiB}MiB. Private report: .folio-ocr/comparison-stronger.json`);
  if (geometry) console.log(`Crop trial: load ${engines[3].loadMs}ms; peak RSS ${engines[3].peakRssMiB}MiB. Timings include saved mobile OCR plus measured extra crop passes; startup is separate.`);
  console.log("Review raw OCR and wrong/no matches; expand to 30–50 labelled real covers before switching. No stock changed.");
}

async function validate() {
  const datasetHash = hash(readFileSync(path.join(root, "cases.json")));
  const cases = load<Case[]>("cases.json");
  for (const name of ["tesseract.json", "paddle.json"]) {
    const result = load<Results>(name);
    if (result.datasetHash !== datasetHash || result.complete === false || result.cases.length !== cases.length ||
      cases.some(sample => !result.cases.some(run => run.id === sample.id))) throw Error(`Incomplete or stale baseline: ${name}`);
  }
  for (const sample of cases) {
    const image = path.resolve(root, sample.image);
    if (!image.startsWith(root + path.sep) || hash(readFileSync(image)) !== sample.sha256 ||
      sample.width > 1600 || sample.height > 1600) throw Error(`Invalid frozen input: ${sample.id}`);
  }
  console.log(`PASS frozen corpus and both saved baselines: ${cases.length} photos. OCR will not be repeated for existing engines.`);
}

const action = process.argv[2];
(action === "prepare" ? prepare() : action === "report" ? report() : action === "validate" ? validate() : Promise.reject(Error("Use prepare, report or validate")))
  .catch(error => { console.error(error instanceof Error ? error.message : "OCR trial failed"); process.exitCode = 1; });
