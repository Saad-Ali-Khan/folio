import path from "node:path";
import englishData from "@tesseract.js-data/eng";
import sharp from "sharp";
import { createWorker, OEM, PSM } from "tesseract.js";

export type CoverLine = { text: string; height: number };

let activeScans = 0;

export async function readCoverLines(image: Buffer, focused = false): Promise<CoverLine[]> {
  if (activeScans >= 2) throw new Error("Cover scanning is busy. Try again in a moment.");
  activeScans += 1;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const preparation = sharp(image, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: focused ? 1800 : 1600, height: focused ? 1800 : 1600, fit: "inside" })
      .flatten({ background: "white" })
      .grayscale();
    const { data: prepared, info } = await (focused ? preparation : preparation.normalize())
      .png().toBuffer({ resolveWithObject: true });
    const langPath = path.join(path.dirname(englishData.langPath), "4.0.0_best_int");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Cover scanning timed out. Try a sharper photo."));
      }, 15_000);
    });
    const starting = createWorker("eng", OEM.LSTM_ONLY, { langPath, cacheMethod: "none", errorHandler: () => {} });
    void starting.then(started => timedOut ? started.terminate() : undefined).catch(() => {});
    worker = await Promise.race([starting, timeout]);
    const engine = worker;
    async function scan(buffer: Buffer, mode: PSM, offset = 0) {
      await Promise.race([engine.setParameters({ tessedit_pageseg_mode: mode }), timeout]);
      const { data } = await Promise.race([engine.recognize(buffer, {}, { blocks: true }), timeout]);
      return (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))
        .filter(line => line.confidence >= 45 && line.text.trim())
        .map(line => ({ text: line.text.trim(), height: line.bbox.y1 - line.bbox.y0, top: offset + line.bbox.y0, confidence: line.confidence }));
    }

    if (!focused) return (await scan(prepared, PSM.SPARSE_TEXT)).sort((a, b) => a.top - b.top);

    // Normalize each band separately so artwork, glare, and the background do
    // not influence recognition of small text elsewhere on the cover.
    const bands = [
      { from: 0.06, to: 0.29, mode: PSM.SINGLE_BLOCK },
      { from: 0.29, to: 0.73, mode: PSM.SPARSE_TEXT },
      { from: 0.79, to: 0.90, mode: PSM.SPARSE_TEXT },
      { from: 0.88, to: 0.99, mode: PSM.SPARSE_TEXT },
    ];
    const lines = new Map<string, Awaited<ReturnType<typeof scan>>[number]>();
    const left = Math.floor(info.width * 0.1);
    for (const band of bands) {
      const top = Math.floor(info.height * band.from);
      const crop = await sharp(prepared).extract({
        left, top, width: info.width - left * 2,
        height: Math.max(1, Math.floor(info.height * band.to) - top),
      }).normalize().sharpen().png().toBuffer();
      for (const line of await scan(crop, band.mode, top)) {
        const key = line.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        if (key && line.confidence > (lines.get(key)?.confidence ?? 0)) lines.set(key, line);
      }
    }
    return [...lines.values()].sort((a, b) => a.top - b.top);
  } finally {
    clearTimeout(timer);
    try { await worker?.terminate(); }
    finally { activeScans -= 1; }
  }
}
