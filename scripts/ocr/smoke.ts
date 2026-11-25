import sharp from "sharp";

/** Synthetic fixture only: the detector gets a canvas, the recognizer a text-line crop. */
export async function smokeImages() {
  const page = await sharp(Buffer.from('<svg width="900" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="160" fill="white"/><text x="25" y="105" font-family="Arial" font-size="64" fill="black">Folio local OCR check</text></svg>')).png().toBuffer();
  const line = await sharp(page).trim({ background: "white", threshold: 10 })
    .extend({ top: 4, bottom: 4, left: 8, right: 8, background: "white" }).png().toBuffer();
  return { page, line };
}
