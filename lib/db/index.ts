import path from "node:path";
import { desc, eq, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export async function createDatabase(): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production.");
  }

  if (url) {
    const [{ default: postgres }, { drizzle }] = await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
    ]);
    const sql = postgres(url, { max: 1 });
    return {
      db: drizzle(sql, { schema }) as unknown as Database,
      close: async () => {
        await sql.end();
      },
    };
  }

  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = new PGlite(path.join(process.cwd(), ".pglite"));
  return {
    db: drizzle(client, { schema }) as unknown as Database,
    close: async () => {
      await client.close();
    },
  };
}

const globalForDb = globalThis as unknown as { folioDb?: Promise<Database> };

export function getDb(): Promise<Database> {
  globalForDb.folioDb ??= createDatabase().then((connection) => connection.db);
  return globalForDb.folioDb;
}

export async function findBooksByIdentifier(
  db: Database,
  identifier: string,
  limit = 2,
): Promise<schema.Book[]> {
  const key = identifier.toLowerCase();
  if (key.startsWith("slug:")) {
    return db.select().from(schema.books).where(eq(schema.books.slug, key.slice(5).trim())).limit(1);
  }
  const isbn = identifier.replace(/[-\s]/g, "");
  const byIsbn = eq(schema.books.isbn, isbn);
  const bySlug = eq(schema.books.slug, key);
  const matches = await db
    .select()
    .from(schema.books)
    .where(or(byIsbn, bySlug, sql`lower(${schema.books.title}) = ${key}`))
    .orderBy(desc(byIsbn), desc(bySlug), schema.books.id)
    .limit(limit);
  const first = matches[0];
  // A plain slug may also be the title of another edition, such as "dune".
  return first?.isbn === isbn ? [first] : matches;
}
