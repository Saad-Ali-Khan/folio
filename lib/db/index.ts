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
    if (new URL(url).hostname.endsWith(".neon.tech")) {
      const [{ Pool, neon, neonConfig }, { drizzle: drizzleTransactions }, { drizzle: drizzleHttp }, { default: WebSocket }, { fetch: databaseFetch }] = await Promise.all([
        import("@neondatabase/serverless"),
        import("drizzle-orm/neon-serverless"),
        import("drizzle-orm/neon-http"),
        import("ws"),
        import("undici"),
      ]);
      neonConfig.webSocketConstructor = WebSocket;
      // Database connections outlive a render and must use an independent
      // HTTP client instead of Next.js's request-scoped fetch wrapper.
      neonConfig.fetchFunction = (
        input: Parameters<typeof databaseFetch>[0],
        options?: Parameters<typeof databaseFetch>[1],
      ) => databaseFetch(input, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal as AbortSignal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
      neonConfig.poolQueryViaFetch = false;
      const pool = new Pool({
        connectionString: url,
        max: 3,
        connectionTimeoutMillis: 20_000,
        idleTimeoutMillis: 20_000,
      });
      const transactions = drizzleTransactions(pool, { schema });
      const db = drizzleHttp(neon(url, {
        fetchOptions: { cache: "no-store" },
      }), { schema });
      // Ordinary statements use HTTPS. Interactive transactions need a
      // dedicated WebSocket so every statement runs on the same connection.
      Object.defineProperty(db, "transaction", {
        value: transactions.transaction.bind(transactions),
      });
      return {
        db: db as unknown as Database,
        close: async () => { await pool.end(); },
      };
    }
    const [{ default: postgres }, { drizzle }] = await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
    ]);
    const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 20 });
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

const globalForDb = globalThis as unknown as {
  folioDb?: Promise<Database>;
  folioDbUrl?: string;
};

export function getDb(): Promise<Database> {
  const url = process.env.DATABASE_URL?.trim();
  const cacheKey = url && new URL(url).hostname.endsWith(".neon.tech") ? `${url}#neon-undici-bounded-transactions` : url;
  if (globalForDb.folioDbUrl !== cacheKey) {
    globalForDb.folioDb = undefined;
    globalForDb.folioDbUrl = cacheKey;
  }
  if (!globalForDb.folioDb) {
    const pending = createDatabase().then(connection => connection.db);
    globalForDb.folioDb = pending;
    void pending.catch(() => {
      if (globalForDb.folioDb === pending) globalForDb.folioDb = undefined;
    });
  }
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
