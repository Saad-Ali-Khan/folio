import type { ImportMetadata } from "./import-metadata";

// British Council's public record API is keyed by record ID. Add entries here
// after checking that the catalogue record lists the edition's exact ISBN.
const britishCouncil = new Map([
  ["9789696400837", {
    title: "The Little Prince",
    author: "Antoine de Saint-Exupéry",
    record: 44236,
  }],
]);

export function lookupBritishCouncil(isbn: string): ImportMetadata | null {
  const edition = britishCouncil.get(isbn13(isbn));
  return edition ? {
    title: edition.title,
    author: edition.author,
    isbn,
    coverUrl: null,
    titleNote: `Details from the British Council catalogue (record ${edition.record}).`,
  } : null;
}

type HathiTrustRecord = { isbns?: string[]; titles?: string[]; "marc-xml"?: string };

// HathiTrust can return an ISBN-13 when the same edition was queried by ISBN-10.
function isbn13(isbn: string) {
  const normalized = isbn.replace(/[\s-]/g, "").toUpperCase();
  if (!/^\d{9}[\dX]$/.test(normalized)) return normalized;
  const checksum = Array.from(normalized, (digit, index) => (digit === "X" ? 10 : Number(digit)) * (10 - index))
    .reduce((sum, digit) => sum + digit, 0);
  if (checksum % 11) return normalized;
  const digits = `978${normalized.slice(0, 9)}`;
  const total = Array.from(digits, (digit, index) => Number(digit) * (index % 2 ? 3 : 1))
    .reduce((sum, digit) => sum + digit, 0);
  return digits + ((10 - total % 10) % 10);
}

function marcAuthor(xml: string) {
  // HathiTrust supplies MARCXML. Only the primary personal or corporate name
  // is needed, without the dates and relationship designators in other fields.
  const field = xml.match(/<(?:\w+:)?datafield\b[^>]*\btag="(100|110)"[^>]*>([\s\S]*?)<\/(?:\w+:)?datafield>/);
  const name = field?.[2].match(/<(?:\w+:)?subfield\b[^>]*\bcode="a"[^>]*>([^<]*)<\/(?:\w+:)?subfield>/)?.[1];
  if (!name) return "Unknown author";
  const entities: Record<string, string> = { amp: "&", apos: "'", lt: "<", gt: ">", quot: '"' };
  const decoded = name.replace(/&(#x[\da-f]+|#\d+|amp|apos|lt|gt|quot);/gi, (match, code: string) => {
    if (!code.startsWith("#")) return entities[code] ?? match;
    const point = code.startsWith("#x") ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  }).trim().replace(/,$/, "");
  const inverted = field?.[1] === "100" ? decoded.match(/^([^,]+),\s*([^,]+)$/) : null;
  return (inverted ? `${inverted[2]} ${inverted[1]}` : decoded) || "Unknown author";
}

export async function lookupHathiTrust(isbn: string): Promise<ImportMetadata | null> {
  const response = await fetch(`https://catalog.hathitrust.org/api/volumes/full/isbn/${isbn}.json`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HathiTrust HTTP ${response.status}`);

  const { records } = await response.json() as { records: Record<string, HathiTrustRecord> };
  const matches = Object.values(records).flatMap(record => {
    const title = record.titles?.[0]?.trim();
    if (!title || !record.isbns?.some(candidate => isbn13(candidate) === isbn13(isbn))) return [];
    return [{ title, author: marcAuthor(record["marc-xml"] ?? "") }];
  });
  const [first] = matches;
  if (!first || matches.some(match => match.title !== first.title || match.author !== first.author)) return null;
  return { ...first, isbn, coverUrl: null, titleNote: "Details from the HathiTrust catalogue." };
}
