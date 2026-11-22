import { normalizeCoverText, type CoverCandidate, type CatalogReader } from "./cover-catalogs";
import { canonicalIsbn } from "./isbn";

/** Read only the exact catalog record whose artwork was compared, never related editions or marketing prose. */
export async function enrichReadingsEdition(candidate: CoverCandidate, read: CatalogReader, signal: AbortSignal): Promise<CoverCandidate> {
  const id = candidate.source.match(/^https:\/\/readings\.com\.pk\/book\/([1-9]\d*)$/)?.[1];
  if (!id) return candidate;
  try {
    const data = JSON.parse((await read(`https://htk3x7p5jf.ap-south-1.awsapprunner.com/api/books/${id}`, signal, 1_000_000)).toString()) as {
      book?: { Book_Id?: number; BOOK_TITLE?: string; BOOK_ISBN?: string; authorName?: string;
        BOOK_LANGUAGE?: string; binding?: string; PUBLISHED_DATE?: string };
    };
    const book = data.book;
    const expectedIsbn = candidate.identity.startsWith("isbn:") ? canonicalIsbn(candidate.identity.slice(5)) : null;
    if (!book || book.Book_Id !== Number(id) || typeof book.BOOK_TITLE !== "string" || typeof book.authorName !== "string" ||
      typeof book.BOOK_ISBN !== "string" || !expectedIsbn || canonicalIsbn(book.BOOK_ISBN) !== expectedIsbn ||
      normalizeCoverText(book.BOOK_TITLE) !== normalizeCoverText(candidate.title) || normalizeCoverText(book.authorName) !== normalizeCoverText(candidate.author)) return candidate;
    const language = ({ E: "English", U: "Urdu" } as Record<string, string>)[book.BOOK_LANGUAGE ?? ""] ?? "";
    const binding = typeof book.binding === "string" ? book.binding.trim().slice(0, 100) : "";
    const year = typeof book.PUBLISHED_DATE === "string" && /^\d{4}-\d{2}-\d{2}/.test(book.PUBLISHED_DATE) ? book.PUBLISHED_DATE.slice(0, 4) : "";
    return { ...candidate, language, edition: [binding, year ? `published ${year}` : ""].filter(Boolean).join(" · ") };
  } catch { return candidate; }
}
