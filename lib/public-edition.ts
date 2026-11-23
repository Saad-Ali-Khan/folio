import type { EditionCandidate } from "./edition-types";
import { canonicalIsbn } from "./isbn";

const fields = ["publisher", "translator", "language", "edition"] as const;
type Fields = Record<typeof fields[number], string>;
type RecordDetails = Fields & { reviewStatus: string; candidates: EditionCandidate[] };
export function publicEdition(isbn: string, details: RecordDetails | undefined): Fields & { source?: string; catalog?: string } {
  const empty: Fields = { publisher: "", translator: "", language: "", edition: "" };
  if (!details) return empty;
  if (details.reviewStatus === "reviewed") return Object.fromEntries(fields.map(field => [field, details[field]])) as Fields;
  const key = canonicalIsbn(isbn);
  const candidate = key && details.candidates.filter(value => value.isbn && canonicalIsbn(value.isbn) === key)
    .sort((a, b) => fields.filter(field => details[field] && details[field] === b[field]).length -
      fields.filter(field => details[field] && details[field] === a[field]).length)[0];
  if (!candidate) return empty;
  const supported = Object.fromEntries(fields.map(field => [field,
    details[field] && details[field] === candidate[field] ? details[field] : ""])) as Fields;
  return { ...supported, ...(fields.some(field => supported[field]) ? { source: candidate.source, catalog: candidate.catalog } : {}) };
}
