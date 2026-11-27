import sharp from "sharp";
import { createHash } from "node:crypto";
import { canonicalIsbn } from "./isbn";
import { enrichReadingsEdition } from "./readings-edition";
import type { ImportMetadata } from "./import-metadata";
import { fitsCover, googleBooksCovers, openLibraryCovers, type CoverCandidate } from "./cover-catalogs";

// Public endpoints used by Readings' own catalog. No API key or paid search.
const API = "https://htk3x7p5jf.ap-south-1.awsapprunner.com";
const IMAGES = "https://d9z6htgewkjtb.cloudfront.net";
type RecordMatch = { Book_Id: number; BOOK_TITLE: string; authorName: string; publisherName: string; BOOK_ISBN: string };
type Fingerprint = { pixels: Buffer; colors: number[] };

export async function boundedFetch(url: string, signal: AbortSignal, maxBytes: number) {
  const response = await fetch(url, { signal, redirect: "error" });
  return boundedBody(response, maxBytes);
}

async function boundedBody(response: Response, maxBytes: number) {
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw new Error("Publisher unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty publisher response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Publisher response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

// Open Library may redirect a cover to its Internet Archive storage shard.
// Validate every hop against the original cover ID; never follow arbitrary URLs.
export async function readCatalogCover(url: string, signal: AbortSignal, maxBytes: number, request: typeof fetch = fetch) {
  if (!url.startsWith('https://covers.openlibrary.org/')) return boundedFetch(url, signal, maxBytes);
  const match = /^https:\/\/covers\.openlibrary\.org\/b\/id\/([1-9]\d*)-L\.jpg\?default=false$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error('Invalid Open Library cover URL');
  const id = Number(match[1]), group = `l_covers_${Math.floor(id / 1_000_000).toString().padStart(4,'0')}`;
  const zip = `${group}_${Math.floor(id % 1_000_000 / 10_000).toString().padStart(2,'0')}.zip`;
  const file = `${match[1].padStart(10,'0')}-L.jpg`;
  const legacy = `olcovers${Math.floor(id / 10_000)}`;
  const layouts = [{group,zip,file},{group:legacy,zip:`${legacy}-L.zip`,file:`${id}-L.jpg`}];
  const allowed = (target: URL) => {
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash) return false;
    if (target.href === url) return true;
    if (target.hostname === 'archive.org') return !target.search && layouts.some(row=>target.pathname === `/download/${row.group}/${row.zip}/${row.file}`);
    return /^ia\d{6}\.us\.archive\.org$/.test(target.hostname) && target.pathname === '/view_archive.php' &&
      layouts.some(row=>target.searchParams.get('file') === row.file &&
        new RegExp(`^/\\d+/items/${row.group}/${row.zip.replace('.', '\\.')}$`).test(target.searchParams.get('archive') ?? '')) &&
      [...target.searchParams.keys()].sort().join(',') === 'archive,file';
  };
  let target = new URL(url);
  const visited = new Set<string>();
  for (let hop=0; hop<=3; hop++) {
    if (!allowed(target) || visited.has(target.href)) throw Error('Untrusted Open Library cover redirect');
    visited.add(target.href);
    const response = await request(target.href, {signal, redirect:'manual'});
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || hop === 3) throw Error('Open Library cover redirect limit');
      target = new URL(location, target); continue;
    }
    if (response.headers.get('content-type') && !response.headers.get('content-type')!.toLowerCase().startsWith('image/')) {
      await response.body?.cancel(); throw Error('Open Library cover did not return an image');
    }
    return boundedBody(response, Math.min(maxBytes,2_000_000));
  }
  throw Error('Open Library cover unavailable');
}

async function fingerprint(image: Buffer, inset = 0): Promise<Fingerprint> {
  const upright = await sharp(image, { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width: 800, height: 1200, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "white" }).png().toBuffer();
  const { width = 0, height = 0 } = await sharp(upright).metadata();
  const left = Math.floor(width * inset), top = Math.floor(height * inset);
  const resized = await sharp(upright).extract({ left, top, width: width - left * 2, height: height - top * 2 })
    .resize(12, 16, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  // Spatial color layout distinguishes different jackets of the same work.
  const colors = Array.from(resized, value => value / 255);
  const pixels = await sharp(resized, { raw: { width: 12, height: 16, channels: 3 } })
    .greyscale().normalize().raw().toBuffer();
  return { pixels, colors };
}

function distance(a: Fingerprint, b: Fingerprint) {
  const gray = a.pixels.reduce((sum, value, i) => sum + Math.abs(value - b.pixels[i]) / 255, 0) / a.pixels.length;
  // Compensate for overall exposure while retaining hue and spatial differences.
  const exposure = a.colors.reduce((sum, value, i) => sum + value - b.colors[i], 0) / a.colors.length;
  const color = a.colors.reduce((sum, value, i) => sum + Math.abs(value - b.colors[i] - exposure), 0) / a.colors.length;
  return { gray, color, score: gray * 0.5 + color * 0.5 };
}

export async function coverDistance(upload: Buffer, catalog: Buffer) {
  const variants = await Promise.all([0, 0.04, 0.08].map(inset => fingerprint(upload, inset)));
  return compare(variants, catalog);
}

async function compare(variants: Fingerprint[], catalog: Buffer) {
  const reference = await fingerprint(catalog);
  return variants.map(variant => distance(variant, reference)).sort((a, b) => a.score - b.score)[0];
}

/** Artwork enrichment only. A matching jacket never establishes a physical ISBN. */
export async function lookupPublisherCover(image: Buffer, meta: ImportMetadata, clues: string[]): Promise<ImportMetadata> {
  if (meta.isbn) return meta;
  const signal = AbortSignal.timeout(12_000);
  try {
    const catalogSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
    const sources = await Promise.allSettled([
      readingsCovers(meta, catalogSignal),
      openLibraryCovers(meta, boundedFetch, catalogSignal),
      googleBooksCovers(meta, boundedFetch, catalogSignal),
    ]);
    // Give each catalog a bounded share. An outage in one leaves others usable.
    const candidates = sources.flatMap(source => source.status === "fulfilled"
      ? source.value.filter(candidate => fitsCover(candidate, meta, clues)).slice(0, 6) : []);
    if (!candidates.length) return meta;
    const variants = await Promise.all([0, 0.04, 0.08].map(inset => fingerprint(image, inset)));
    const compared = [];
    // Four image downloads at a time keep memory and external load bounded.
    for (let start = 0; start < candidates.length; start += 4) {
      compared.push(...await Promise.all(candidates.slice(start, start + 4).map(async candidate => {
      try {
        const bytes = await readCatalogCover(candidate.coverUrl, signal, 2_000_000);
        return { candidate, ...await compare(variants, bytes) };
      } catch { return null; }
      })));
    }
    // Multiple sources for one ISBN corroborate it rather than creating a tie.
    const editions = new Map<string, NonNullable<typeof compared[number]>>();
    for (const result of compared) {
      if (result && result.score < (editions.get(result.candidate.identity)?.score ?? Infinity)) editions.set(result.candidate.identity, result);
    }
    // Reused jackets and near ties remain unverified, even within one publisher.
    const ranked = [...editions.values()].sort((a, b) => a.score - b.score);
    // Review proposals tolerate lighting/framing differences more than automatic artwork selection.
    // Keep the strict automatic threshold below unchanged; a proposal never establishes an edition.
    const reviewMatches = ranked.filter(result => (result.gray <= 0.22 && result.color <= 0.22) ||
      (result.gray <= 0.32 && result.color <= 0.18)).slice(0, 5);
    const closeCandidates = await Promise.all(reviewMatches.map(({ candidate }) => enrichReadingsEdition(candidate, boundedFetch, signal)));
    const editionCandidates = closeCandidates.map((candidate, index) => ({
      id: createHash("sha256").update(candidate.source).digest("hex").slice(0, 24),
      title: candidate.title.slice(0, 300), author: candidate.author.slice(0, 300),
      publisher: candidate.publisher === "Publisher not recorded" ? "" : candidate.publisher.slice(0, 300),
      translator: candidate.translator ?? "", language: candidate.language ?? "", edition: candidate.edition ?? "",
      matchQuality: reviewMatches[index].gray <= 0.16 && reviewMatches[index].color <= 0.16 ? "close" as const : "possible" as const,
      isbn: candidate.identity.startsWith("isbn:") ? canonicalIsbn(candidate.identity.slice(5)) : null,
      coverUrl: candidate.coverUrl, source: candidate.source, catalog: candidate.catalog,
    }));
    const proposed = editionCandidates.length ? { ...meta, editionCandidates } : meta;
    const [best, runnerUp] = ranked;
    if (!best || best.gray > 0.16 || best.color > 0.16 || (runnerUp && runnerUp.score - best.score < 0.035)) return proposed;
    const match = best.candidate;
    const note = `Cover artwork visually matched to ${match.title}, published by ${match.publisher}, in ${match.catalog}. Source: ${match.source}. Physical ISBN and translator remain unverified.`;
    return { ...proposed, coverUrl: match.coverUrl, description: note, titleNote: [meta.titleNote, note].filter(Boolean).join(" ") };
  } catch {
    // Publisher/network failures must not discard a successful work identification.
    return meta;
  }
}

export async function readingsCovers(meta: Pick<ImportMetadata, "title">, signal: AbortSignal): Promise<CoverCandidate[]> {
  const data = JSON.parse((await boundedFetch(`${API}/api/autocomplete?search=${encodeURIComponent(meta.title.slice(0, 150))}`, signal, 512_000)).toString()) as { results?: RecordMatch[] };
  return (data.results ?? []).flatMap(record => {
    if (!Number.isSafeInteger(record.Book_Id) || record.Book_Id <= 0 ||
        typeof record.BOOK_TITLE !== "string" || typeof record.authorName !== "string" ||
        typeof record.publisherName !== "string" || !/^97[89]\d{10}$/.test(record.BOOK_ISBN)) return [];
    return [{ title: record.BOOK_TITLE, author: record.authorName, publisher: record.publisherName,
      coverUrl: `${IMAGES}/${record.BOOK_ISBN}.webp`, source: `https://readings.com.pk/book/${record.Book_Id}`,
      catalog: "Readings catalog", identity: `isbn:${record.BOOK_ISBN}` }];
  });
}
