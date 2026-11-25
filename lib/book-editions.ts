import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { bookEditions, books } from "./db/schema";
import { canonicalIsbn } from "./isbn";
import type { EditionCandidate, EditionDetails, EditionInput } from "./edition-types";

export class EditionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function getEdition(db: Database, bookId: number): Promise<EditionDetails> {
  const [row] = await db.select().from(bookEditions).where(eq(bookEditions.bookId, bookId));
  return { publisher: row?.publisher ?? "", translator: row?.translator ?? "", language: row?.language ?? "",
    edition: row?.edition ?? "", evidence: row?.evidence ?? "", reviewed: row?.reviewStatus === "reviewed",
    revision: row?.revision ?? 0, candidates: row?.candidates ?? [] };
}

export function parseEditionInput(input: unknown): EditionInput {
  if (!input || typeof input !== "object") throw new EditionError("Reload edition details before saving.");
  const raw = input as Record<string, unknown>;
  const text = (key: string, max: number) => {
    if (typeof raw[key] !== "string" || raw[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw[key])) throw new EditionError(`Invalid edition ${key}.`);
    return raw[key].trim();
  };
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0 || typeof raw.reviewed !== "boolean" ||
    typeof raw.isbnConfirmed !== "boolean" || typeof raw.useArtwork !== "boolean") throw new EditionError("Reload edition details before saving.");
  const parsed: EditionInput = { publisher: text("publisher", 300), translator: text("translator", 300), language: text("language", 100),
    edition: text("edition", 300), evidence: text("evidence", 3500), reviewed: raw.reviewed, linkIsbn: text("linkIsbn", 40),
    isbnConfirmed: raw.isbnConfirmed, isbnEvidence: text("isbnEvidence", 1000), candidateId: text("candidateId", 200), useArtwork: raw.useArtwork,
    expectedRevision: Number(raw.expectedRevision), expectedIsbn: text("expectedIsbn", 200) };
  if (parsed.reviewed && !parsed.evidence) throw new EditionError("Record the source or physical page used to verify edition details.");
  if (parsed.linkIsbn && (!canonicalIsbn(parsed.linkIsbn) || !parsed.isbnConfirmed)) {
    throw new EditionError("Enter a valid ISBN and confirm it from the physical copy.");
  }
  return parsed;
}

/** Called inside the book-save transaction: no stock movement, merge, or external lookup. */
export async function saveEdition(db: Database, bookId: number, input: EditionInput) {
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).for("update");
  if (!book || book.isbn !== input.expectedIsbn) throw new EditionError("This ISBN changed. Refresh inventory before saving.", 409);
  const previous = await getEdition(db, bookId);
  if (previous.revision !== input.expectedRevision) throw new EditionError("Edition details changed. Refresh inventory before saving.", 409);
  const chosen = input.candidateId ? previous.candidates.find(candidate => candidate.id === input.candidateId) : undefined;
  if (input.useArtwork && !chosen) throw new EditionError("Select a stored catalog candidate before applying its cover.");
  let isbn = book.isbn;
  if (input.useArtwork && chosen?.isbn && canonicalIsbn(book.isbn) && canonicalIsbn(chosen.isbn) !== canonicalIsbn(book.isbn)) {
    throw new EditionError("This catalog cover belongs to a different ISBN. Choose the matching edition's proposal.", 409);
  }
  if (input.linkIsbn) {
    const normalized = canonicalIsbn(input.linkIsbn)!;
    if (!book.isbn.startsWith("manual-") && canonicalIsbn(book.isbn) !== normalized) {
      throw new EditionError("This listing already has an ISBN. Review that edition separately; replacing its ISBN is not supported.", 409);
    }
    // ISBN identifies the publication; listing ID owns this row's stock/details.
    isbn = normalized;
  }
  const isbnSource = chosen?.isbn && canonicalIsbn(chosen.isbn) === isbn
    ? ` Catalog reference: ${chosen.catalog}, ${chosen.source}.` : "";
  const evidence = [input.evidence, input.linkIsbn
    ? `Physical ISBN ${isbn}: admin confirmed against the physical copy.${isbnSource}${input.isbnEvidence ? ` Note: ${input.isbnEvidence}` : ""}` : ""].filter(Boolean).join("\n");
  if (evidence.length > 3500) throw new EditionError("Edition evidence is too long.");
  await db.insert(bookEditions).values({ bookId, publisher: input.publisher, translator: input.translator, language: input.language,
    edition: input.edition, evidence, reviewStatus: input.reviewed ? "reviewed" : "unverified", revision: previous.revision + 1 })
    .onConflictDoUpdate({ target: bookEditions.bookId, set: { publisher: input.publisher, translator: input.translator, language: input.language,
      edition: input.edition, evidence, reviewStatus: input.reviewed ? "reviewed" : "unverified", revision: previous.revision + 1, updatedAt: new Date() } });
  const [updated] = await db.update(books).set({ isbn, ...(input.useArtwork && chosen ? { coverUrl: chosen.coverUrl } : {}) })
    .where(eq(books.id, bookId)).returning();
  return updated;
}

/** Catalog evidence is retained as proposals; verified fields and physical ISBN are untouched. */
export async function storeEditionCandidates(db: Database, bookId: number, candidates: EditionCandidate[]) {
  if (!candidates.length) return;
  const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).for("update");
  if (!book) throw new EditionError("This listing was removed.", 409);
  const current = await getEdition(db, bookId);
  const all = [...candidates, ...current.candidates];
  const combined = all.filter((candidate, index) => all.findIndex(other => other.id === candidate.id) === index).slice(0, 10);
  await db.insert(bookEditions).values({ bookId, candidates: combined, revision: current.revision + 1 })
    .onConflictDoUpdate({ target: bookEditions.bookId, set: { candidates: combined, revision: current.revision + 1, updatedAt: new Date() } });
}
