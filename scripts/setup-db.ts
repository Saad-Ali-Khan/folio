import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createDatabase } from "../lib/db";
import { applyMigrations } from "../lib/db/migrations";

async function main() {
  const directory = path.join(process.cwd(), "drizzle");
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  if (!files.length) throw new Error("No SQL migrations found. Run npm run db:generate first.");

  const migrations = await Promise.all(files.map(async name => ({
    name,
    contents: await readFile(path.join(directory, name), "utf8"),
  })));
  const { db, close } = await createDatabase();
  try {
    const applied = await applyMigrations(db, migrations);
    for (const name of applied) console.log(`Applied ${name}`);
    console.log(applied.length ? `Database ready (${applied.length} migrations applied).` : "Database already up to date.");
  } finally {
    await close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
