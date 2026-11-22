import type { ImportMetadata } from "./import-metadata";

export type CoverCandidate = {
  title: string; author: string; publisher: string; coverUrl: string;
  source: string; catalog: string; identity: string;
  translator?: string; language?: string; edition?: string;
};
export type CatalogReader = (url: string, signal: AbortSignal, maxBytes: number) => Promise<Buffer>;

export function catalogLanguage(code: unknown) {
  if (typeof code !== "string" || !/^[a-z]{2,3}$/i.test(code)) return "";
  try { return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code.toLowerCase()) ?? ""; } catch { return ""; }
}

function shortText(value: unknown, max = 300) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

export function normalizeCoverText(text: string) {
  return text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function titleKey(title: string) {
  return normalizeCoverText(title.replace(/\s*\([^)]*\)\s*$/, "")).replace(/^(the|a|an) /, "");
}

export function fitsCover(candidate: CoverCandidate, meta: ImportMetadata, clues: string[]) {
  const visible = normalizeCoverText(clues.join(" "));
  const hints = ["readings", "penguin", "puffin", "oxford", "wordsworth", "vintage", "scholastic", "harpercollins", "macmillan", "liberty"]
    .filter(imprint => new RegExp(`\\b${imprint}\\b`).test(visible));
  const publisher = normalizeCoverText(candidate.publisher);
  return titleKey(candidate.title) === titleKey(meta.title) &&
    normalizeCoverText(candidate.author) === normalizeCoverText(meta.author) &&
    (!hints.length || hints.some(hint => new RegExp(`\\b${hint}\\b`).test(publisher)));
}

function identity(isbns: unknown, fallback: string) {
  const values = Array.isArray(isbns) ? isbns : [];
  // Used only to group repeated catalog evidence, never assigned to inventory.
  const isbn = values.find(value => typeof value === "string" && /^97[89]\d{10}$/.test(value));
  return isbn ? `isbn:${isbn}` : fallback;
}

export async function openLibraryCovers(meta: ImportMetadata, read: CatalogReader, signal: AbortSignal): Promise<CoverCandidate[]> {
  if (!meta.coverWorkId || !/^OL\d+W$/.test(meta.coverWorkId)) return [];
  const source = `https://openlibrary.org/works/${meta.coverWorkId}/editions.json?limit=40`;
  const data = JSON.parse((await read(source, signal, 1_000_000)).toString()) as {
    entries?: { key?: string; title?: string; publishers?: string[]; covers?: number[]; isbn_13?: string[]; works?: { key?: string }[];
      languages?: { key?: string }[]; edition_name?: string; contributors?: { role?: string; name?: string }[] }[];
  };
  return (data.entries ?? []).flatMap(edition => {
    const cover = edition.covers?.find(value => Number.isSafeInteger(value) && value > 0);
    if (!edition.key || !/^\/books\/OL\d+M$/.test(edition.key) || !edition.title || !cover ||
        !edition.works?.some(work => work.key === `/works/${meta.coverWorkId}`)) return [];
    return [{ title: edition.title, author: meta.author, publisher: edition.publishers?.join(", ") ?? "Publisher not recorded",
      language: (edition.languages ?? []).map(language => catalogLanguage(language.key?.match(/^\/languages\/([a-z]{3})$/)?.[1])).filter(Boolean).join(", ").slice(0, 100),
      edition: shortText(edition.edition_name),
      translator: (edition.contributors ?? []).filter(person => typeof person.role === "string" && person.role.trim().toLowerCase() === "translator")
        .map(person => shortText(person.name)).filter(Boolean).join(", ").slice(0, 300),
      coverUrl: `https://covers.openlibrary.org/b/id/${cover}-L.jpg?default=false`,
      source: `https://openlibrary.org${edition.key}`, catalog: "Open Library edition catalog",
      identity: identity(edition.isbn_13, `openlibrary:${edition.key}`) }];
  });
}

export async function googleBooksCovers(meta: ImportMetadata, read: CatalogReader, signal: AbortSignal): Promise<CoverCandidate[]> {
  const params = new URLSearchParams({ q: `intitle:"${meta.title.slice(0, 150)}" inauthor:"${meta.author.slice(0, 100)}"`, maxResults: "20", printType: "books" });
  // An optional key uses the operator's quota. Public requests can be throttled.
  const key = process.env.GOOGLE_BOOKS_API_KEY?.trim();
  if (key) params.set("key", key);
  const data = JSON.parse((await read(`https://www.googleapis.com/books/v1/volumes?${params}`, signal, 1_000_000)).toString()) as {
    items?: { id?: string; volumeInfo?: { title?: string; authors?: string[]; publisher?: string; language?: string; publishedDate?: string;
      imageLinks?: { thumbnail?: string }; industryIdentifiers?: { identifier?: string }[] } }[];
  };
  return (data.items ?? []).flatMap(item => {
    const info = item.volumeInfo;
    if (!item.id || !/^[\w-]{1,100}$/.test(item.id) || !info?.title || !info.imageLinks?.thumbnail) return [];
    let image: URL;
    try { image = new URL(info.imageLinks.thumbnail); } catch { return []; }
    // Catalog responses cannot direct the local bot to arbitrary hosts.
    if (image.hostname !== "books.google.com" || image.pathname !== "/books/content" || image.username || image.password || image.port) return [];
    if (!["http:", "https:"].includes(image.protocol)) return [];
    image.protocol = "https:";
    const author = info.authors?.find(name => normalizeCoverText(name) === normalizeCoverText(meta.author));
    if (!author) return [];
    return [{ title: info.title, author, publisher: info.publisher ?? "Publisher not recorded", coverUrl: image.href,
      language: catalogLanguage(info.language), edition: typeof info.publishedDate === "string" && /^\d{4}(?:-|$)/.test(info.publishedDate) ? `Published ${info.publishedDate.slice(0, 4)}` : "",
      source: `https://books.google.com/books?id=${item.id}`, catalog: "Google Books",
      identity: identity(info.industryIdentifiers?.map(value => value.identifier), `google:${item.id}`) }];
  });
}
