import { readCoverLines, type CoverLine } from "./cover-ocr";
import { prepareOcrImage, makeCoverViews, readingOrder, type LocatedLine } from "./cover-geometry";
import { callLocalOcr } from "./local-ocr-client";
import { CatalogUnavailable, lookupCoverMetadata, type ImportMetadata } from "./import-metadata";

type Match = { metadata: ImportMetadata | null; lines: CoverLine[]; suggestionLines?: CoverLine[]; stage: "mobile" | "tesseract" | "crops" };
type Dependencies = {
  tesseract(image: Buffer, focused?: boolean): Promise<CoverLine[]>;
  mobile(image: Buffer, signal: AbortSignal): Promise<LocatedLine[]>;
  crops(image: Buffer, lines: LocatedLine[], signal: AbortSignal): Promise<LocatedLine[]>;
  lookup(lines: CoverLine[], retry?: boolean): Promise<ImportMetadata | null>;
};

async function mobile(image: Buffer, signal: AbortSignal) { return (await callLocalOcr(image, "detect", signal)).lines!; }
async function crops(image: Buffer, baseline: LocatedLine[], signal: AbortSignal) {
  const metadata = await import("sharp").then(({ default: sharp }) => sharp(image).metadata());
  const lines = [...baseline];
  for (const view of await makeCoverViews(image, baseline)) {
    signal.throwIfAborted();
    const result = await callLocalOcr(view.data, view.mode, signal);
    if (view.anchor) lines.push({ ...view.anchor, text: result.text!, confidence: result.confidence });
    else lines.push(...result.lines!.map(line => ({ ...line,
      top: (view.region.top + line.top! * view.region.height) / metadata.height!,
      height: line.height * view.region.height / metadata.height! })));
  }
  return readingOrder(lines);
}
const defaults: Dependencies = { tesseract: readCoverLines, mobile, crops, lookup: lookupCoverMetadata };

/** Pure recognition/catalog policy: never writes inventory, sends messages or guesses a title. */
export async function recognizeCoverStages(image: Buffer, enabled: boolean, signal: AbortSignal,
  deps: Dependencies = defaults): Promise<Match> {
  signal.throwIfAborted();
  let mobileLines: LocatedLine[] | undefined;
  if (enabled) {
    try { mobileLines = await deps.mobile(image, signal); }
    catch { signal.throwIfAborted(); /* Worker offline/busy: use the existing engine. */ }
    if (mobileLines) {
      signal.throwIfAborted();
      const metadata = await deps.lookup(mobileLines, true);
      signal.throwIfAborted();
      if (metadata) return { metadata, lines: mobileLines, stage: "mobile" };
    }
  }
  const initial = await deps.tesseract(image);
  signal.throwIfAborted();
  if (!enabled) {
    let first;
    try { first = await deps.lookup(initial); }
    catch (error) { if (!(error instanceof CatalogUnavailable)) throw error; }
    signal.throwIfAborted();
    if (first) return { metadata: first, lines: initial, stage: "tesseract" };
  }
  const combined = [...initial, ...await deps.tesseract(image, true)];
  signal.throwIfAborted();
  const metadata = await deps.lookup(combined, true);
  signal.throwIfAborted();
  if (metadata || !mobileLines) return { metadata, lines: combined, ...(!metadata ? {suggestionLines: [...(mobileLines ?? []),...combined]} : {}), stage: "tesseract" };
  try {
    const lines = await deps.crops(image, mobileLines, signal);
    signal.throwIfAborted();
    const cropMetadata = await deps.lookup(lines, true);
    signal.throwIfAborted();
    return { metadata: cropMetadata, lines, ...(!cropMetadata ? {suggestionLines:[...mobileLines,...combined,...lines]} : {}), stage: "crops" };
  } catch (error) {
    if (error instanceof CatalogUnavailable || signal.aborted) throw error;
    return { metadata: null, lines: combined, suggestionLines:[...mobileLines,...combined], stage: "crops" };
  }
}

const runtime = globalThis as typeof globalThis & { folioCoverRecognitionBusy?: boolean };
export async function recognizeCover(image: Buffer): Promise<Match> {
  if (runtime.folioCoverRecognitionBusy) throw Error("Cover scanning is busy. Try again in a moment.");
  runtime.folioCoverRecognitionBusy = true;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error("Cover scanning timed out. No stock was added.")); }, 40_000);
  });
  const work = (async () => {
    const prepared = await prepareOcrImage(image);
    controller.signal.throwIfAborted();
    return recognizeCoverStages(prepared, process.env.FOLIO_OCR_ENGINE === "paddle", controller.signal);
  })().finally(() => { clearTimeout(timer); runtime.folioCoverRecognitionBusy = false; });
  return Promise.race([work, deadline]);
}
