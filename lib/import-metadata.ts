import type { CoverLine } from "./cover-ocr";
import type { BookMetadata } from "./discord-inventory";
import { lookupBritishCouncil, lookupHathiTrust } from "./isbn-catalogs";

type Edition = { title?: string; language?: string[] };
type SearchDoc = { key?: string; title?: string; author_name?: string[]; cover_i?: number; edition_count?: number; editions?: { docs?: Edition[] } };
export type TitleOptions = { english: string; original: string };
export type ImportMetadata = BookMetadata & { titleOptions?: TitleOptions; titleNote?: string };
type IsbnLookup = { status: "found"; metadata: ImportMetadata } | { status: "missing" | "unavailable" };

const fields = "key,title,author_name,cover_i,edition_count,editions,editions.title,editions.language";

export class CatalogUnavailable extends Error {}

const coverCache = globalThis as typeof globalThis & {
  folioCoverMatches?: Map<string, { result: ImportMetadata; expires: number }>;
};

async function search(params: URLSearchParams, limit = 1, timeoutMs = 5000): Promise<SearchDoc[]> {
  params.set("fields", fields);
  params.set("limit", String(limit));
  params.set("lang", "en");
  try {
    const response = await fetch(`https://openlibrary.org/search.json?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Open Library HTTP ${response.status}`);
    return ((await response.json()) as { docs?: SearchDoc[] }).docs ?? [];
  } catch (error) {
    throw new CatalogUnavailable("Open Library lookup failed", { cause: error });
  }
}

function words(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function workId(doc: SearchDoc) {
  return doc.key?.match(/^(?:\/works\/)?(OL\d+W)$/)?.[1];
}

async function metadataFromDoc(doc: SearchDoc & { title: string }, isbn: string | null): Promise<ImportMetadata> {
  const edition = doc.editions?.docs?.[0];
  const meta: ImportMetadata = {
    title: edition?.title?.trim() || doc.title.trim(),
    author: doc.author_name?.[0] || "Unknown author",
    isbn,
    coverUrl: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`
      : doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
  };
  const id = workId(doc);
  let english = edition?.language?.includes("eng") ? edition : undefined;
  if (!english && id) {
    try {
      const [translation] = await search(new URLSearchParams({ q: `key:/works/${id} AND language:eng` }));
      const candidate = translation && workId(translation) === id ? translation.editions?.docs?.[0] : undefined;
      if (candidate?.language?.includes("eng")) english = candidate;
    } catch {
      // Keep the identified title if the translation lookup is unavailable.
    }
  }
  const englishTitle = english?.title?.trim();
  if (!englishTitle) {
    meta.titleNote = "No verified English title was found. Review the catalog title in inventory.";
    return meta;
  }

  const catalogTitle = doc.title.trim();
  const alternative = words(catalogTitle) !== words(englishTitle) ? catalogTitle : edition?.title?.trim();
  meta.title = englishTitle;
  if (alternative && words(alternative) !== words(englishTitle)) {
    meta.titleOptions = { english: englishTitle, original: alternative };
  }
  return meta;
}

export async function lookupImportMetadata(query: { isbn: string } | { title: string }): Promise<ImportMetadata | null> {
  if ("isbn" in query) {
    const result = await lookupIsbnMetadata(query.isbn);
    return result.status === "found" ? result.metadata : null;
  }
  try {
    const [doc] = await search(new URLSearchParams({ title: query.title }));
    return doc?.title ? await metadataFromDoc({ ...doc, title: doc.title }, null) : null;
  } catch {
    return null;
  }
}

export async function lookupIsbnMetadata(isbn: string): Promise<IsbnLookup> {
  if (!/^(?:97[89]\d{10}|\d{9}[\dX])$/.test(isbn)) return { status: "missing" };

  let lookupFailed = false;
  try {
    const [doc] = await search(new URLSearchParams({ isbn }));
    if (doc?.title) return { status: "found", metadata: await metadataFromDoc({ ...doc, title: doc.title }, isbn) };
  } catch {
    lookupFailed = true;
  }

  // The Search index and direct Books API can have different coverage.
  const key = `ISBN:${isbn}`;
  const params = new URLSearchParams({ bibkeys: key, jscmd: "data", format: "json" });
  try {
    const response = await fetch(`https://openlibrary.org/api/books?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Open Library HTTP ${response.status}`);
    const records = await response.json() as Record<string, { title?: string; authors?: { name?: string }[] }>;
    const edition = records[key];
    if (edition?.title?.trim()) {
      return { status: "found", metadata: {
        title: edition.title.trim(),
        author: edition.authors?.[0]?.name?.trim() || "Unknown author",
        isbn,
        coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
      } };
    }
  } catch {
    lookupFailed = true;
  }

  const regionalEdition = lookupBritishCouncil(isbn);
  if (regionalEdition) return { status: "found", metadata: regionalEdition };

  try {
    const edition = await lookupHathiTrust(isbn);
    if (edition) return { status: "found", metadata: edition };
  } catch {
    lookupFailed = true;
  }
  return { status: lookupFailed ? "unavailable" : "missing" };
}

export async function lookupCoverMetadata(lines: CoverLine[], retry = false): Promise<ImportMetadata | null> {
  const cover = lines.map(line => ({ text: words(line.text), height: line.height })).filter(line => line.text);
  const cache = coverCache.folioCoverMatches ??= new Map();
  const cacheKey = JSON.stringify(cover);
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;
  const visibleWords = new Set(cover.flatMap(line => line.text.split(" ")));
  const phrases = new Map<string, number>();
  for (let start = 0; start < cover.length; start++) {
    for (let count = 1; count <= 3 && start + count <= cover.length; count++) {
      const part = cover.slice(start, start + count);
      const text = part.map(line => line.text).join(" ");
      if (text.length < 3 || text.length > 100) continue;
      const height = part.reduce((sum, line) => sum + line.height, 0) / count;
      phrases.set(text, Math.max(phrases.get(text) ?? 0, height));
    }
  }
  const queries = [...phrases].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 18);
  if (!queries.length) return null;

  const queryFor = (count: number) => new URLSearchParams({ q: queries.slice(0, count).map(([text]) => `title:"${text}"`).join(" OR ") });
  let docs: SearchDoc[];
  try {
    docs = await search(queryFor(18), 24, retry ? 8000 : 4500);
  } catch (error) {
    if (!retry || !(error instanceof CatalogUnavailable)) throw error;
    // Retry with fewer phrases so a large search cannot keep timing out.
    docs = await search(queryFor(6), 24, 8000);
  }
  const matches = new Map<string, { doc: SearchDoc & { title: string }; prominence: number; title: string; author: string }>();
  for (const doc of docs) {
    const id = workId(doc);
    const author = doc.author_name?.[0];
    if (!id || !doc.title || !author) continue;
    const authorWords = words(author).split(" ").filter(word => word.length > 1);
    if (!authorWords.length || !authorWords.every(word => visibleWords.has(word))) continue;
    const titles = [doc.title, doc.editions?.docs?.[0]?.title].flatMap(title =>
      title ? [title, ...title.split(/\s+\/\s+|[():]/)].map(words) : []);
    const title = titles.sort((a, b) => (phrases.get(b) ?? 0) - (phrases.get(a) ?? 0))[0];
    const prominence = phrases.get(title) ?? 0;
    if (prominence && prominence > (matches.get(id)?.prominence ?? 0)) {
      matches.set(id, { doc: { ...doc, title: doc.title }, prominence, title, author: words(author) });
    }
  }
  const [best, ...alternatives] = [...matches.entries()].sort((a, b) =>
    b[1].prominence - a[1].prominence || (b[1].doc.edition_count ?? 0) - (a[1].doc.edition_count ?? 0));
  if (!best) return null;
  const [id, match] = best;
  let englishEdition: Edition | undefined;
  for (const [, candidate] of alternatives) {
    if (candidate.prominence < match.prominence * 0.85) break;
    // Open Library sometimes has duplicate work records for the same title and author.
    const duplicate = candidate.title === match.title && candidate.author === match.author;
    const established = (match.doc.edition_count ?? 0) >= Math.max(3, 3 * (candidate.doc.edition_count ?? 0));
    if (!duplicate || !established) return null;
    const edition = candidate.doc.editions?.docs?.[0];
    if (edition?.language?.length === 1 && edition.language[0] === "eng" &&
        edition.title && words(edition.title) === match.title) englishEdition = edition;
  }
  // Prefer an exact English title over a bilingual or collection label.
  const selected = match.doc.editions?.docs?.[0];
  const exactEnglish = selected?.language?.length === 1 && selected.language[0] === "eng" &&
    words(selected.title ?? "") === match.title;
  const doc = englishEdition && !exactEnglish
    ? { ...match.doc, editions: { docs: [englishEdition] } }
    : match.doc;
  const result = { ...await metadataFromDoc(doc, null), coverWorkId: id };
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { result, expires: Date.now() + 30 * 60_000 });
  return result;
}
