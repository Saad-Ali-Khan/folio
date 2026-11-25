import assert from "node:assert/strict";
import sharp from "sharp";
import { smokeImages } from "./ocr/smoke";

async function main() {
  const { page, line } = await smokeImages();
  const pageInfo = await sharp(page).metadata(), lineInfo = await sharp(line).metadata();
  assert.equal(pageInfo.height, 160);
  assert(lineInfo.height! < 100 && lineInfo.height! > 30, "direct recognition receives a cropped line rather than the canvas");
  const { data, info } = await sharp(line).grayscale().raw().toBuffer({ resolveWithObject: true });
  const inkRows = new Set<number>();
  for (let i = 0; i < data.length; i++) if (data[i] < 128) inkRows.add(Math.floor(i / info.width));
  assert(inkRows.size > info.height * .65, "blank margins cannot shrink lettering to a small fraction of the model input height");
  assert(lineInfo.width! > lineInfo.height! * 4, "one horizontal text line");
  console.log(`PASS smoke fixture: ${pageInfo.width}x${pageInfo.height} canvas; ${lineInfo.width}x${lineInfo.height} cropped line, ${inkRows.size} ink rows. No model, network or stock operations.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
