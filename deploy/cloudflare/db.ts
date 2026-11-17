import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@/lib/db/schema";

export type Database = NeonDatabase<typeof schema>;

export async function getDb(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the Cloudflare storefront.");

  // Close the WebSocket when Drizzle releases it after a query or transaction.
  const pool = new Pool({
    connectionString: url,
    max: 1,
    maxUses: 1,
    connectionTimeoutMillis: 10_000,
  });
  return drizzle(pool, { schema });
}
