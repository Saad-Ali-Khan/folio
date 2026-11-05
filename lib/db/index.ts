import path from "node:path";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export async function createDatabase(): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  const url = process.env.DATABASE_URL?.trim();

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
