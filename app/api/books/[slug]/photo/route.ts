import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { readWithRetry } from "@/lib/db/read";
import { bookPhotos, books } from "@/lib/db/schema";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await getDb();
  const [photo] = await readWithRetry(() => db.select({ data: bookPhotos.data }).from(bookPhotos)
    .innerJoin(books, eq(books.id, bookPhotos.bookId))
    .where(and(
      eq(books.slug, slug),
      eq(books.status, "published"), gt(books.priceCents, 0),
    )).limit(1));
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!photo) return new Response(null, { status: 404, headers });
  return new Response(Buffer.from(photo.data, "base64"), {
    headers: { ...headers, "Content-Type": "image/webp" },
  });
}
