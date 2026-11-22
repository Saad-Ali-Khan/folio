import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { books, bookPhotos } from "@/lib/db/schema";
import { requestIsAdmin, sameOrigin } from "@/lib/admin-auth";
import { EditionError, getEdition, storeEditionCandidates } from "@/lib/book-editions";
import { lookupPublisherCover } from "@/lib/publisher-cover";
import { consumeRequestLimit } from "@/lib/request-limits";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!requestIsAdmin(request)) return Response.json({ error: "Please unlock inventory." }, { status: 401 });
  let input;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!Number.isInteger(input?.bookId) || input.bookId < 1 || input.bookId > 2147483647 ||
    !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) return Response.json({ error: "Invalid listing or revision." }, { status: 400 });
  try {
    const db = await getDb();
    const [book] = await db.select().from(books).where(eq(books.id, input.bookId));
    if (!book) return Response.json({ error: "Listing not found." }, { status: 404 });
    const before = await getEdition(db, book.id);
    if (before.revision !== input.expectedRevision) throw new EditionError("Edition details changed. Refresh inventory first.", 409);
    const [photo] = await db.select().from(bookPhotos).where(eq(bookPhotos.bookId, book.id));
    if (!photo) throw new EditionError("Upload a full-cover photo through Discord before searching by cover.");
    if (!await consumeRequestLimit(db, `edition-candidates:${book.id}`, 3, 60)) throw new EditionError("Please wait a minute before searching this cover again.", 429);
    const result = await lookupPublisherCover(Buffer.from(photo.data, "base64"), { title: book.title, author: book.author, isbn: null, coverUrl: null,
      coverWorkId: book.isbn.match(/^manual-cover-(ol\d+w)$/i)?.[1].toUpperCase() }, []);
    const edition = await db.transaction(async tx => {
      const [current] = await tx.select().from(books).where(eq(books.id, book.id)).for("update");
      const latest = await getEdition(tx as unknown as Database, book.id);
      if (!current || current.isbn !== book.isbn || current.title !== book.title || current.author !== book.author || latest.revision !== before.revision) {
        throw new EditionError("This listing changed during the search. Refresh inventory first.", 409);
      }
      await storeEditionCandidates(tx as unknown as Database, book.id, result.editionCandidates ?? []);
      return getEdition(tx as unknown as Database, book.id);
    });
    return Response.json({ edition, isbn: book.isbn, found: result.editionCandidates?.length ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EditionError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Catalog search could not complete. No listing or stock was changed." }, { status: 503 });
  }
}
