import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";

export async function GET(request: Request) {
  const idsParam = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = Array.from(
    new Set(
      idsParam
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ).slice(0, 50);

  if (ids.length === 0) {
    return Response.json({ books: [] });
  }

  try {
    const db = await getDb();
    const rows = await db
      .select({
        id: books.id,
        priceCents: books.priceCents,
        stock: books.stock,
      })
      .from(books)
      .where(and(inArray(books.id, ids), eq(books.status, "published"), gt(books.priceCents, 0)));
    return Response.json({ books: rows });
  } catch (error) {
    console.error("Failed to load book availability", error);
    return Response.json(
      { error: "Could not load book availability." },
      { status: 500 },
    );
  }
}
