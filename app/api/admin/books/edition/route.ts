import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { getEdition } from "@/lib/book-editions";
import { requestIsAdmin } from "@/lib/admin-auth";

export async function GET(request: Request) {
  if (!requestIsAdmin(request)) return Response.json({ error: "Please unlock inventory." }, { status: 401 });
  const id = Number(new URL(request.url).searchParams.get("bookId"));
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) return Response.json({ error: "Invalid book ID." }, { status: 400 });
  try {
    const db = await getDb();
    const [book] = await db.select({ isbn: books.isbn }).from(books).where(eq(books.id, id));
    if (!book) return Response.json({ error: "Listing not found." }, { status: 404 });
    return Response.json({ edition: await getEdition(db, id), isbn: book.isbn }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Edition details could not load. Check that database setup has completed, then refresh." }, { status: 503 });
  }
}
