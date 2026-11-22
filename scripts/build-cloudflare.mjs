import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".folio-cloudflare");
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, "build-"));

const localRoutes = new Set([
  "app/api/local",
  "app/api/discord",
  "app/api/sms",
  "app/api/telegram",
  "app/api/webhooks/stripe",
  "app/checkout/success",
]);

for (const file of ["app", "components", "lib", "public", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "package.json", "package-lock.json"]) {
  cpSync(join(root, file), join(stage, file), {
    recursive: true,
    filter: source => !localRoutes.has(relative(root, source).replaceAll("\\", "/")),
  });
}

for (const [source, destination] of [
  ["db.ts", "lib/db/index.ts"],
  ["open-next.config.ts", "open-next.config.ts"],
  ["wrangler.jsonc", "wrangler.jsonc"],
]) {
  cpSync(join(root, "deploy", "cloudflare", source), join(stage, destination));
}

const bookPagePath = join(stage, "app", "books", "[slug]", "page.tsx");
const bookPage = readFileSync(bookPagePath, "utf8");
// Without Cache Components, use a dynamic route to resolve the slug per request.
writeFileSync(bookPagePath, bookPage.replace(
  /^export const instant = false;$/m,
  'export const dynamic = "force-dynamic";',
));

const temp = join(stage, ".tmp");
mkdirSync(temp);
const env = { ...process.env, FOLIO_CLOUDFLARE: "1", TEMP: temp, TMP: temp };
for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "APP_URL", "NEXT_PUBLIC_APP_URL", "COD_WHATSAPP_NUMBER"]) {
  delete env[key];
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this build through npm.");
const manifestPath = join(stage, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.scripts.build = "next build --webpack";
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: stage, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Cloudflare build directory: ${stage}`);
run([npmCli, "ci", "--include=dev", "--no-audit", "--no-fund"]);
run([npmCli, "exec", "--", "opennextjs-cloudflare", "build"]);

if (process.argv.includes("--deploy")) {
  if (!existsSync(join(stage, ".open-next", "worker.js"))) {
    throw new Error(`Cloudflare build did not produce a Worker bundle in ${stage}.`);
  }
  console.log(`Deploying Cloudflare build from ${stage}`);
  run([npmCli, "exec", "--", "wrangler", "deploy"]);
}
