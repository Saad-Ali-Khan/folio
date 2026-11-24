import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { readWithRetry } from "@/lib/db/read";
import { bookPhotos, books } from "@/lib/db/schema";
import { readBookPhotoResult } from "@/lib/book-photos";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await getDb();
  const [photo] = await readWithRetry(() => db.select({ data: bookPhotos.data, objectKey: bookPhotos.objectKey }).from(bookPhotos)
    .innerJoin(books, eq(books.id, bookPhotos.bookId))
    .where(and(
      eq(books.slug, slug),
      eq(books.status, "published"), gt(books.priceCents, 0),
    )).limit(1));
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!photo) return new Response(null, { status: 404, headers });
  try {
    const { data, source } = await readBookPhotoResult(db, photo);
    return new Response(new Uint8Array(data), {
      headers: { ...headers, "Content-Type": "image/webp", "X-Folio-Photo-Storage": source },
    });
  } catch { return new Response(null, { status: 503, headers }); }
}
