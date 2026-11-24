import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = process.cwd(), output = join(root, ".folio-cloudflare");
const artifact = join(output, "r2-release-artifacts"); mkdirSync(artifact, { recursive: true });
const roots = ["app", "components", "deploy", "docs", "drizzle", "lib", "public", "scripts"];
const files = [".env.example", ".gitignore", "AGENTS.md", "BACKLOG.md", "README.md", "drizzle.config.ts", "eslint.config.mjs", "next.config.ts", "package.json", "package-lock.json", "postcss.config.mjs", "tsconfig.json"];
function collect(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.name.startsWith(".") || lstatSync(join(root, name)).isSymbolicLink()) throw new Error(`Unexpected hidden file or symlink in source: ${name}`);
    if (entry.isDirectory()) collect(name); else files.push(name);
  }
}
roots.forEach(collect); files.sort();
for (const file of files) if (!existsSync(join(root, file))) throw new Error(`Missing source file: ${file}`);
const checks = JSON.parse(readFileSync(join(output, "r2-photo-checks.json"), "utf8"));
if (!checks.length) throw new Error("Run live R2 photo verification first.");
writeFileSync(join(artifact, "photo-release-checks.json"), JSON.stringify(checks, null, 2) + "\n");
const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const manifest = { createdAt: new Date().toISOString(), baseCommit: base.stdout.trim(), source: "working-tree snapshot; includes uncommitted R2 work", files: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")])) };
writeFileSync(join(artifact, "release-source-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const list = join(artifact, "files.txt"); writeFileSync(list, files.join("\n") + "\n");
const tar = process.platform === "win32" ? "tar.exe" : "tar";
const plain = resolve(output, "release-r2-20261123.tar"), archive = plain + ".gz";
function run(args) { const result = spawnSync(tar, args, { cwd: root, stdio: "inherit", windowsHide: true }); if (result.error || result.status !== 0) throw new Error("Source archive preparation failed."); }
run(["-cf", plain, "-T", list]);
run(["-rf", plain, "-C", artifact, "photo-release-checks.json", "release-source-manifest.json"]);
writeFileSync(archive, gzipSync(readFileSync(plain))); rmSync(plain);
const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(join(output, "release-r2-20261123.sha256"), `${sha}  release-r2-20261123.tar.gz\n`);
writeFileSync(join(output, "deploy-r2.sh"), readFileSync(join(root, "deploy/cloudflare/deploy-r2.sh"), "utf8").replaceAll("\r\n", "\n"), { mode: 0o700 });
console.log(`Prepared ${files.length} source files and photo checks: ${archive}`);
console.log("Excluded local credentials, backups, recovery keys, Git data and local runtime folders.");
