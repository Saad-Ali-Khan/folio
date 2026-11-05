import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

type Backend = {
  applied: () => Promise<Set<string>>;
  exec: (statement: string) => Promise<void>;
  record: (name: string) => Promise<void>;
  close: () => Promise<void>;
};

async function connect(): Promise<Backend> {
  const url = process.env.DATABASE_URL?.trim();

  if (url) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1 });
    return {
      applied: async () => {
        const rows = (await sql.unsafe(
          "select name from _folio_migrations",
        )) as unknown as { name: string }[];
        return new Set(rows.map((row) => row.name));
      },
      exec: async (statement) => {
        await sql.unsafe(statement);
      },
      record: async (name) => {
        await sql`insert into _folio_migrations (name) values (${name}) on conflict do nothing`;
      },
      close: async () => {
        await sql.end();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(path.join(process.cwd(), ".pglite"));
  return {
    applied: async () => {
      const result = await client.query<{ name: string }>(
        "select name from _folio_migrations",
      );
      return new Set(result.rows.map((row) => row.name));
    },
    exec: async (statement) => {
      await client.exec(statement);
    },
    record: async (name) => {
      await client.query(
        "insert into _folio_migrations (name) values ($1) on conflict do nothing",
        [name],
      );
    },
    close: async () => {
      await client.close();
    },
  };
}

async function main() {
  const backend = await connect();
  try {
    await backend.exec(
      "create table if not exists _folio_migrations (name text primary key, applied_at timestamptz not null default now())",
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      throw new Error(
        "No SQL migrations found in ./drizzle. Run `npm run db:generate` first.",
      );
    }

    const applied = await backend.applied();
    let appliedCount = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const statements = contents
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await backend.exec(statement);
      }
      await backend.record(file);
      appliedCount += 1;
      console.log(`Applied ${file}`);
    }

    console.log(
      appliedCount > 0
        ? `Database ready (${appliedCount} migration(s) applied).`
        : "Database already up to date.",
    );
  } finally {
    await backend.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
