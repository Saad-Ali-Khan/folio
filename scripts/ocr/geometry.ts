import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CoverLine } from "../../lib/cover-ocr";

type LocatedLine = CoverLine & { left?: number };
type View = { image: string; sha256: string; width: number; height: number; mode: "detect" | "recognize";
  region: { left: number; top: number; width: number; height: number }; anchor?: LocatedLine };
const root = path.resolve(".folio-ocr");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export { readingOrder } from "../../lib/cover-geometry";
import { readingOrder, makeCoverViews } from "../../lib/cover-geometry";

async function prepare() {
  const manifest = readFileSync(path.join(root, "cases.json"));
  const cases = JSON.parse(manifest.toString()) as { id: string; image: string; sha256: string; width: number; height: number }[];
  const baseline = JSON.parse(readFileSync(path.join(root, "paddle.json"), "utf8")) as {
    datasetHash: string; complete: boolean; cases: { id: string; lines: LocatedLine[] }[] };
  if (!baseline.complete || baseline.datasetHash !== hash(manifest)) throw Error("Mobile baseline is incomplete or stale");
  mkdirSync(path.join(root, "geometry-inputs"), { recursive: true });
  const result = [];
  for (const sample of cases) {
    const image = path.resolve(root, sample.image);
    if (!image.startsWith(root + path.sep) || hash(readFileSync(image)) !== sample.sha256) throw Error(`Input changed: ${sample.id}`);
    const base = baseline.cases.find(run => run.id === sample.id);
    if (!base) throw Error(`Missing mobile reading: ${sample.id}`);
    const views: View[] = [];
    const generated = await makeCoverViews(readFileSync(image), base.lines);
    for (let i = 0; i < generated.length; i++) {
      const { data, ...view } = generated[i];
      const file = `geometry-inputs/${sample.id}-view-${i}.png`;
      writeFileSync(path.join(root, file), data);
      views.push({ ...view, image: file, sha256: hash(data) });
    }
    result.push({ id: sample.id, width: sample.width, height: sample.height, views });
  }
  writeFileSync(path.join(root, "geometry-inputs.json"), JSON.stringify({ datasetHash: hash(manifest), cases: result }, null, 2));
  console.log(`Prepared generic crop/line views for ${result.length} frozen photos; no labels used to select crops.`);
}

function order() {
  const file = path.join(root, "paddle-geometry.json");
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (!report.complete) throw Error("Incomplete geometry trial");
  for (const run of report.cases) { run.rawLines ??= run.lines; run.lines = readingOrder(run.rawLines); }
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log("Applied trial row reading order; raw coordinates retained separately.");
}
if (path.basename(process.argv[1] ?? "") === "geometry.ts") {
  const action = process.argv[2];
  (action === "prepare" ? prepare() : action === "order" ? Promise.resolve().then(order) : Promise.reject(Error("Use prepare or order")))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
