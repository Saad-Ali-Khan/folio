import sharp from "sharp";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  EAN13Reader,
  NotFoundException,
  ChecksumException,
  FormatException,
  RGBLuminanceSource,
} from "@zxing/library";

const ROTATIONS = [0, 90, 180, 270] as const;

const HINTS = new Map<DecodeHintType, unknown>();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
HINTS.set(DecodeHintType.TRY_HARDER, true);

async function decodeAtRotation(
  input: Buffer,
  rotation: number,
  enhance = false,
): Promise<string | null> {
  let pipeline = sharp(input)
    .rotate(rotation, { background: "white" })
    .flatten({ background: "white" })
    .grayscale()
    .normalize();
  if (enhance) {
    const metadata = await sharp(input).metadata();
    pipeline = pipeline
      .resize({ width: Math.min((metadata.width ?? 800) * 3, 2400) })
      .sharpen();
  }
  const { data, info } = await pipeline
    // ZXing expects exactly one luminance byte per pixel, including for RGBA input.
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const source = new RGBLuminanceSource(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
  );
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  try {
    const result = new EAN13Reader().decode(bitmap, HINTS);
    return normalizeIsbn(result.getText());
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ChecksumException ||
      error instanceof FormatException
    ) return null;
    throw error;
  }
}

export async function decodeBarcode(image: Buffer): Promise<string | null> {
  // Apply phone EXIF orientation first and bound the cost of repeated attempts.
  const prepared = await sharp(image, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  for (const rotation of ROTATIONS) {
    const text = await decodeAtRotation(prepared, rotation);
    if (text) return text;
  }

  // Overlapping crops isolate small barcodes from dark backgrounds and text.
  const { width = 1, height = 1 } = await sharp(prepared).metadata();
  const cropWidth = Math.ceil(width * 0.6);
  const cropHeight = Math.ceil(height * 0.6);
  const deadline = Date.now() + 8000;
  for (const y of [0, 0.5, 1]) {
    for (const x of [0, 0.5, 1]) {
      const crop = await sharp(prepared).extract({
        left: Math.round((width - cropWidth) * x),
        top: Math.round((height - cropHeight) * y),
        width: cropWidth,
        height: cropHeight,
      }).png().toBuffer();
      // ZXing already tries reversed rows, so 180/270 are redundant here.
      for (const rotation of [0, 90, -5, 5, 85, 95]) {
        if (Date.now() >= deadline) return null;
        const text = await decodeAtRotation(crop, rotation, true);
        if (text) return text;
      }
    }
  }
  return null;
}

function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function normalizeIsbn(raw: string): string | null {
  const value = raw.replace(/[^0-9Xx]/g, "").toUpperCase();

  if (/^97[89]\d{10}$/.test(value)) {
    return value.slice(0, 12) + ean13CheckDigit(value.slice(0, 12)) === value
      ? value
      : null;
  }

  if (/^\d{9}[\dX]$/.test(value)) {
    const checksum = [...value].reduce(
      (sum, digit, index) => sum + (digit === "X" ? 10 : Number(digit)) * (10 - index),
      0,
    );
    if (checksum % 11 !== 0) return null;
    const core = value.slice(0, 9);
    const prefix = `978${core}`;
    return prefix + ean13CheckDigit(prefix);
  }

  return null;
}
