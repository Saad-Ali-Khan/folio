import sharp from "sharp";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from "@zxing/library";

const ROTATIONS = [0, 90, 180, 270] as const;

const HINTS = new Map<DecodeHintType, unknown>();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
HINTS.set(DecodeHintType.TRY_HARDER, true);

async function decodeAtRotation(
  input: Buffer,
  rotation: number,
): Promise<string | null> {
  const { data, info } = await sharp(input)
    .rotate(rotation)
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const source = new RGBLuminanceSource(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
  );
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  try {
    const result = new MultiFormatReader().decode(bitmap, HINTS);
    return result.getText();
  } catch (error) {
    if (error instanceof NotFoundException) return null;
    throw error;
  }
}

export async function decodeBarcode(image: Buffer): Promise<string | null> {
  for (const rotation of ROTATIONS) {
    const text = await decodeAtRotation(image, rotation);
    if (text) return text;
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
    const core = value.slice(0, 9);
    const prefix = `978${core}`;
    return prefix + ean13CheckDigit(prefix);
  }

  return null;
}
