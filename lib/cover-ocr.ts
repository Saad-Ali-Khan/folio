import path from "node:path";
import englishData from "@tesseract.js-data/eng";
import sharp from "sharp";
import { createWorker, OEM, PSM } from "tesseract.js";
import { coverTextBands, dominantCoverLine } from "./cover-layout";

// OCR emits image-relative coordinates so different passes share reading order.
export type CoverLine = { text: string; height: number; top?: number; confidence?: number };

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
      .resize({ width: 1600, height: 1600, fit: "inside" })
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
    const optionalDeadline = Date.now() + 10_000;
    await engine.setParameters({ user_defined_dpi: "150" });
    async function scan(buffer: Buffer, mode: PSM, offset = 0) {
      await Promise.race([engine.setParameters({ tessedit_pageseg_mode: mode }), timeout]);
      const { data } = await Promise.race([engine.recognize(buffer, {}, { blocks: true }), timeout]);
      const recognized = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines));
      if (mode === PSM.SINGLE_LINE) {
        // Artwork can lower a line's score even when its title word is clear.
        return recognized.flatMap(line => line.words)
          .filter(word => word.confidence >= 65 && /[\p{L}]{2}/u.test(word.text))
          .map(word => ({ text: word.text.trim(), height: word.bbox.y1 - word.bbox.y0,
            top: offset + word.bbox.y0, confidence: word.confidence }));
      }
      return recognized
        .filter(line => line.confidence >= 45 && line.text.trim())
        .map(line => ({ text: line.text.trim(), height: line.bbox.y1 - line.bbox.y0, top: offset + line.bbox.y0, confidence: line.confidence }));
    }

    if (!focused) return (await scan(prepared, PSM.SPARSE_TEXT))
      .map(line => ({ ...line, top: line.top / info.height, height: line.height / info.height }));

    // Normalize each band separately so artwork, glare, and the background do
    // not influence recognition of small text elsewhere on the cover.
    const bands = [
      { from: 0.06, to: 0.29, mode: PSM.SINGLE_BLOCK },
      { from: 0.29, to: 0.73, mode: PSM.SPARSE_TEXT },
      { from: 0.79, to: 0.90, mode: PSM.SPARSE_TEXT },
      { from: 0.88, to: 0.99, mode: PSM.SPARSE_TEXT },
    ];
    const lines = new Map<string, Awaited<ReturnType<typeof scan>>[number]>();
    const add = (line: Awaited<ReturnType<typeof scan>>[number]) => {
      const key = line.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (key && line.confidence > (lines.get(key)?.confidence ?? 0)) lines.set(key, line);
    };
    // Detect actual text rows instead of assuming a title occupies one cover band.
    // Small, padded line images suit large serif lettering better than a full page.
    const layout = await coverTextBands(await sharp(prepared).normalize().png().toBuffer(), info.width, info.height);
    for (const band of layout.bands) {
      if (Date.now() > optionalDeadline) break;
      const pad = Math.ceil(info.height * 0.004);
      const top = Math.max(0, band.from - pad);
      const height = Math.min(info.height - top, band.to - band.from + pad * 2 + 1);
      const dominant = await dominantCoverLine(layout.binary, layout.width, top, height);
      if (dominant) for (const word of await scan(dominant, PSM.SINGLE_LINE)) {
        add({ ...word, top, height: band.to - band.from });
      }
      for (const rightPart of [false, true]) {
        // The second view separates small conjunctions/ornament from large text.
        // Keep the original full-page and band passes for text near cover edges.
        const left = rightPart ? Math.floor(layout.width * 0.22) : 0;
        const width = rightPart ? layout.width - left : Math.floor(info.width * 0.8);
        const targetHeight = rightPart ? 45 : 90;
        const crop = await sharp(layout.binary).extract({ left, top, width, height })
          .resize({ height: targetHeight }).extend({ top: 10, bottom: 10, left: 10, right: 10, background: "white" })
          .png().toBuffer();
        for (const word of await scan(crop, PSM.SINGLE_LINE)) {
          add({ ...word, top, height: band.to - band.from });
        }
      }
    }
    const left = Math.floor(info.width * 0.1);
    for (const band of bands) {
      if (Date.now() > optionalDeadline) break;
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
    // Expand tall, condensed lettering horizontally and read its band as a
    // single line. Limit extra passes to the two most prominent text bands.
    const prominent = [...lines.values()]
      .filter(line => line.height >= info.height * 0.065)
      .sort((a, b) => b.height - a.height).slice(0, 2);
    const expandedSource = prominent.length
      ? await sharp(prepared).normalize().png().toBuffer()
      : prepared;
    for (const line of prominent) {
      if (Date.now() > optionalDeadline) break;
      const top = Math.max(0, line.top - Math.floor(line.height * 0.04));
      const height = Math.min(info.height - top, Math.floor(line.height * 1.6));
      for (const leftFraction of [0, 0.4]) {
        const left = Math.floor(info.width * leftFraction);
        const width = info.width - left;
        const crop = await sharp(expandedSource).extract({ left, top, width, height })
          .resize({ width: width * 2, height, fit: "fill" })
          .normalize().sharpen().png().toBuffer();
        for (const word of await scan(crop, PSM.SINGLE_LINE, top)) {
          const key = word.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
          if (key && word.confidence > (lines.get(key)?.confidence ?? 0)) lines.set(key, word);
        }
      }
    }
    return [...lines.values()].sort((a, b) => a.top - b.top)
      .map(line => ({ ...line, top: line.top / info.height, height: line.height / info.height }));
  } finally {
    clearTimeout(timer);
    try { await worker?.terminate(); }
    finally { activeScans -= 1; }
  }
}
