import type { CoverLine } from "./cover-ocr";
import type { BookMetadata } from "./discord-inventory";
import { lookupBritishCouncil, lookupHathiTrust } from "./isbn-catalogs";
import { mergeCoverReadings, stackedTitleProminence } from "./cover-title";
import { compatibleCoverAuthor, coverTitleVariants, hasCoverAdaptation, hasCoverFormatLabel, isCoverCollection } from "./cover-catalog-titles";

type Edition = { title?: string; language?: string[] };
type SearchDoc = { key?: string; title?: string; author_name?: string[]; author_key?: string[]; cover_i?: number; edition_count?: number; editions?: { docs?: Edition[] } };
export type TitleOptions = { english: string; original: string };
export type ImportMetadata = BookMetadata & { titleOptions?: TitleOptions; titleNote?: string };
type IsbnLookup = { status: "found"; metadata: ImportMetadata } | { status: "missing" | "unavailable" };

const fields = "key,title,author_name,author_key,cover_i,edition_count,editions,editions.title,editions.language";

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
  const cover = mergeCoverReadings(lines).map(line => ({ ...line, text: words(line.text) })).filter(line => line.text);
  const cache = coverCache.folioCoverMatches ??= new Map();
  const cacheKey = `work-title-v3:${JSON.stringify(cover)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;
  const visibleWords = new Set(cover.flatMap(line => line.text.split(" ")));
  const authorAliases = new Map<string, Promise<string[]>>();
  const visibleAuthor = (name: string) => {
    const parts = words(name).split(" ").filter(word => word.length > 1);
    return parts.length > 0 && parts.every(word => visibleWords.has(word));
  };
  const phrases = new Map<string, number>();
  const queryProminence = new Map<string, number>();
  const confident = cover.filter(line => (line.confidence === undefined || line.confidence >= 65) &&
    !(line.top !== undefined && line.height > 0.25 && line.text.length < 4));
  for (let start = 0; start < confident.length; start++) {
    for (let count = 1; count <= 8 && start + count <= confident.length; count++) {
      const part = confident.slice(start, start + count);
      const text = part.map(line => line.text).join(" ");
      if (text.length < 3 || text.length > 140) continue;
      const height = Math.max(...part.map(line => line.height));
      phrases.set(text, Math.max(phrases.get(text) ?? 0, height));
      queryProminence.set(text, Math.max(queryProminence.get(text) ?? 0, Math.min(...part.map(line => line.height))));
    }
  }
  const queries = [...queryProminence].sort((a, b) => Number(b[0].includes(" ")) - Number(a[0].includes(" ")) ||
    b[1] - a[1] || b[0].length - a[0].length).slice(0, 18);
  if (!queries.length) return null;

  // AND tolerates conjunctions and line breaks omitted by OCR; accepting a
  // result still requires the full visible title evidence and a visible author.
  const queryFor = (count: number) => new URLSearchParams({ q: queries.slice(0, count)
    .map(([text]) => `title:(${text.split(" ").map(word => `"${word}"`).join(" AND ")})`).join(" OR ") });
  let docs: SearchDoc[];
  try {
    docs = await search(queryFor(retry ? 6 : 18), 24, retry ? 10_000 : 4500);
  } catch (error) {
    if (!retry || !(error instanceof CatalogUnavailable)) throw error;
    // Retry with fewer phrases so a large search cannot keep timing out.
    docs = await search(queryFor(3), 24, 10_000);
  }
  type Match = { doc: SearchDoc & { title: string }; prominence: number; title: string; display: string;
    author: string; authorKey?: string; englishTitle?: string };
  const matches = new Map<string, Match>();
  for (const doc of docs) {
    const id = workId(doc);
    let author = doc.author_name?.[0];
    if (!id || !doc.title || !author) continue;
    const evidence = (title: string) => Math.max(phrases.get(title) ?? 0, stackedTitleProminence(title, confident));
    const edition = doc.editions?.docs?.[0];
    // A single book inside a multi-work collection is not the collection.
    if (isCoverCollection(doc.title) && !evidence(words(doc.title))) continue;
    if ([doc.title, edition?.title ?? ""].some(title => hasCoverAdaptation(title) &&
      !evidence(words(title)))) continue;
    if (!visibleAuthor(author)) {
      // English OCR needs catalog aliases for names in another script.
      // Unrelated Latin-script authors can be rejected without extra requests.
      if (!/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(author)) continue;
      // Do not fetch identities for unrelated non-Latin search results.
      if (![doc.title, edition?.title ?? ""].some(title => words(title).split(" ")
        .some(word => word.length >= 4 && visibleWords.has(word)))) continue;
      const key = doc.author_key?.[0];
      if (!key || !/^OL\d+A$/.test(key)) continue;
      let aliases = authorAliases.get(key);
      if (!aliases) {
        aliases = (async () => {
          try {
            const response = await fetch(`https://openlibrary.org/authors/${key}.json`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`Open Library HTTP ${response.status}`);
            const record = await response.json() as { name?: string; alternate_names?: string[] };
            return [record.name, ...(record.alternate_names ?? [])]
              .filter((name): name is string => typeof name === "string").slice(0, 200);
          } catch (error) {
            throw new CatalogUnavailable("Author aliases lookup failed", { cause: error });
          }
        })();
        authorAliases.set(key, aliases);
      }
      author = (await aliases).find(visibleAuthor);
      if (!author) continue;
    }
    const canonical = coverTitleVariants(doc.title, author);
    // Some catalog edition labels append the author without punctuation. Strip
    // that suffix only when the remaining text equals the canonical work title.
    const editionDisplay = edition?.title && words(edition.title) === `${words(doc.title)} ${words(author)}`
      ? doc.title : edition?.title;
    const editionTitles = editionDisplay ? coverTitleVariants(editionDisplay, author, (edition?.language?.length ?? 0) > 1) : [];
    const candidate = [...canonical, ...editionTitles].sort((a, b) => evidence(b.text) - evidence(a.text))[0];
    if (!candidate) continue;
    const { text: title, display } = candidate;
    const prominence = evidence(title);
    if (!prominence) continue;
    const englishTitle = edition?.language?.length === 1 && edition.language[0] === "eng"
      ? editionTitles.find(candidate => candidate.text === title)?.display : undefined;
    if (prominence && prominence > (matches.get(id)?.prominence ?? 0)) {
      matches.set(id, { doc: { ...doc, title: doc.title, author_name: [author] }, prominence, title, display,
        author: words(author), authorKey: doc.author_key?.[0], englishTitle });
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
    const comparableTitle = (title: string) => title.replace(/^(?:the|an|a) /, "");
    const sameTitle = comparableTitle(candidate.title) === comparableTitle(match.title);
    const sharedAuthor = Boolean(match.authorKey && candidate.authorKey === match.authorKey);
    // A weaker abbreviated author label cannot veto a clearly supported full
    // name on a much better established record. It does not establish an alias.
    if (sameTitle && compatibleCoverAuthor(match.author, candidate.author) &&
      (match.doc.edition_count ?? 0) >= Math.max(3, 3 * (candidate.doc.edition_count ?? 0))) continue;
    const duplicate = sameTitle && (candidate.author === match.author || sharedAuthor);
    const established = (match.doc.edition_count ?? 0) >= Math.max(3, (sharedAuthor ? 2 : 3) * (candidate.doc.edition_count ?? 0));
    if (!duplicate || !established) return null;
    if (candidate.englishTitle && comparableTitle(words(candidate.englishTitle)) === comparableTitle(match.title)) {
      englishEdition = { title: candidate.englishTitle, language: ["eng"] };
    }
  }
  // Prefer an exact English title over a bilingual or collection label.
  const safeEnglish = match.englishTitle ? { title: match.englishTitle, language: ["eng"] } : englishEdition;
  if (safeEnglish && words(safeEnglish.title ?? "").replace(/^(?:the|an|a) /, "") ===
    match.title.replace(/^(?:the|an|a) /, "")) safeEnglish.title = match.display;
  const doc = safeEnglish ? { ...match.doc, editions: { docs: [safeEnglish] } } : match.doc;
  // A work match does not verify the physical edition or its translator.
  // Keep the uploaded photo without borrowing another edition's artwork.
  let metadata = await metadataFromDoc(doc, null);
  if (hasCoverFormatLabel(metadata.title)) {
    metadata = { title: match.display, author: match.doc.author_name![0], isbn: null, coverUrl: null,
      titleNote: "The visible work title was retained; catalog edition/format labels remain unverified." };
  }
  const result = { ...metadata, coverUrl: null, coverWorkId: id };
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { result, expires: Date.now() + 30 * 60_000 });
  return result;
}
