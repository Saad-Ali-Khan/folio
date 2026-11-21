import sharp from "sharp";

export async function prepareUploadedCover(image: Buffer): Promise<string> {
  const photo = await sharp(image, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1200, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  if (photo.length > 512 * 1024) {
    throw new Error("The cover photo is too detailed. Send a smaller cover photo.");
  }
  return photo.toString("base64");
}
