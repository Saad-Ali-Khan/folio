import sharp from "sharp";
import type { CoverLine } from "./cover-ocr";
export type LocatedLine = CoverLine & { left?: number };
export async function prepareOcrImage(image: Buffer) {
  return sharp(image, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside" })
    .flatten({ background: "white" }).png().toBuffer();
}
export async function makeCoverViews(image: Buffer, lines: LocatedLine[]) {
  const { width, height } = await sharp(image).metadata();
  if (!width || !height || width > 1600 || height > 1600) throw Error("OCR image must be prepared first");
  const views: { data: Buffer; width: number; height: number; mode: "detect" | "recognize";
    region: { left: number; top: number; width: number; height: number }; anchor?: LocatedLine }[] = [];
  const add = async (mode: "detect" | "recognize", top: number, cropHeight: number, anchor?: LocatedLine) => {
    const region = { left: 0, top, width, height: cropHeight };
    let pipeline = sharp(image).extract(region);
    if (mode === "recognize") pipeline = pipeline.grayscale().normalize().sharpen();
    const { data, info } = await pipeline.resize({ width: 1200, height: 960, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    views.push({ data, width: info.width, height: info.height, mode, region, anchor });
  };
  const half = Math.ceil(height * .6);
  await add("detect", 0, half);
  await add("detect", height - half, half);
  const anchors = [...lines].filter(line => line.top !== undefined && (line.confidence ?? 0) >= 65 &&
    line.height > .015 && line.height < .35 && /[\p{L}\p{N}]{3}/u.test(line.text))
    .sort((a, b) => b.height - a.height).filter((line, i, all) =>
      all.findIndex(other => Math.abs(other.top! - line.top!) < .02) === i).slice(0, 6);
  for (const line of anchors) {
    const padding = line.height < .14 ? .45 : .15;
    const top = Math.max(0, Math.floor((line.top! - line.height * padding) * height));
    const bottom = Math.min(height, Math.ceil((line.top! + line.height * (1 + padding)) * height));
    await add("recognize", top, bottom - top, line);
  }
  return views;
}
/** Group substantially overlapping text regions; retain left-to-right order in a row.
 * Equal row tops let the existing stable top sort preserve this order. Trial only. */
export function readingOrder(lines: LocatedLine[]): LocatedLine[] {
  const rows: { top: number; bottom: number; lines: LocatedLine[] }[] = [];
  for (const line of [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0))) {
    if (line.top === undefined || line.left === undefined) {
      rows.push({ top: line.top ?? 0, bottom: (line.top ?? 0) + line.height, lines: [line] }); continue;
    }
    const row = rows.find(row => row.lines.every(other => other.top !== undefined && other.left !== undefined &&
      (Math.min(other.height, line.height) >= Math.max(other.height, line.height) * .5 ||
        Math.min(other.height, line.height) >= Math.max(other.height, line.height) * .25 &&
        (other.height < line.height ? other.top >= line.top! : line.top! >= other.top)) &&
      Math.min(other.top + other.height, line.top! + line.height) - Math.max(other.top, line.top!) >=
      Math.min(other.height, line.height) * .65));
    if (row) { row.lines.push(line); row.top = Math.min(row.top, line.top); row.bottom = Math.max(row.bottom, line.top + line.height); }
    else rows.push({ top: line.top, bottom: line.top + line.height, lines: [line] });
  }
  return rows.sort((a, b) => a.top - b.top).flatMap(row => row.lines
    .sort((a, b) => (a.left ?? 0) - (b.left ?? 0)).map(line => ({ ...line, top: row.top })));
}
