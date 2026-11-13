import { eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Database } from "./index";

const migrationLog = pgTable("_folio_migrations", { name: text("name").primaryKey() });

export async function applyMigrations(db: Database, migrations: { name: string; contents: string }[]) {
  return db.transaction(async tx => {
    // Serialize concurrent deployment jobs and roll back the ledger with the DDL.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('folio:migrations'))`);
    await tx.execute(sql`create table if not exists _folio_migrations (
      name text primary key, applied_at timestamptz not null default now()
    )`);

    const applied: string[] = [];
    for (const migration of migrations) {
      const [existing] = await tx.select().from(migrationLog).where(eq(migrationLog.name, migration.name));
      if (existing) continue;

      const statements = migration.contents.split("--> statement-breakpoint");
      for (const statement of statements) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      await tx.insert(migrationLog).values({ name: migration.name });
      applied.push(migration.name);
    }
    return applied;
  });
}
