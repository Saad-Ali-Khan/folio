import { and, desc, eq, lt } from "drizzle-orm";
import { requestIsAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { stockMovements } from "@/lib/db/schema";

const pageSize = 25;
const headers = { "Cache-Control": "no-store" };

function validId(id: number) {
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
}

export async function GET(request: Request) {
  if (!requestIsAdmin(request)) {
    return Response.json({ error: "Unlock inventory to view stock history." }, { status: 401, headers });
  }

  const query = new URL(request.url).searchParams;
  const bookId = Number(query.get("bookId"));
  const before = query.has("before") ? Number(query.get("before")) : undefined;
  if (!validId(bookId) || (before !== undefined && !validId(before))) {
    return Response.json({ error: "Invalid stock history request." }, { status: 400, headers });
  }

  try {
    const db = await getDb();
    const rows = await db.select().from(stockMovements)
      .where(and(eq(stockMovements.bookId, bookId), before === undefined ? undefined : lt(stockMovements.id, before)))
      .orderBy(desc(stockMovements.id)).limit(pageSize + 1);
    const movements = rows.slice(0, pageSize);
    const nextBefore = rows.length > pageSize ? movements.at(-1)?.id : null;
    return Response.json({ movements, nextBefore }, { headers });
  } catch {
    return Response.json({ error: "Stock history could not load. Try again." }, { status: 503, headers });
  }
}
