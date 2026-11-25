import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createDatabase } from "../../lib/db";
import { books, bookPhotos } from "../../lib/db/schema";
import { createR2PhotoStore } from "../../lib/r2-photo-store";

type Sample = { id: string; image: string; expectedTitle: string; expectedAuthor: string; group: string; source: string; labelStatus: string; expectedTitleAliases?: string[] };
type WebSource = Omit<Sample, "image"> & { imageUrl: string };
const root = path.resolve(".folio-ocr"), manifest = path.join(root, "collected-cases.json");
const mode = process.argv[2];
const normalize = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function download(url: string, hosts: Set<string>, limit = 6 * 1024 * 1024) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !hosts.has(parsed.hostname) || parsed.username || parsed.password) throw Error("Unexpected download host.");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok || Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw Error(`Download HTTP ${response.status} or oversized response`); }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty download");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > limit) throw Error("Download exceeds trial limit"); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function saveImage(id: string, image: Buffer) {
  const target = path.join(root, "corpus", `${id}.png`);
  await sharp(image, { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).flatten({ background: "white" })
    .png().toFile(target);
  return target;
}

async function contactSheets(samples: Sample[]) {
  mkdirSync(path.join(root, "review"), { recursive: true });
  for (const group of new Set(samples.map(sample => sample.group))) {
    const selected = samples.filter(sample => sample.group === group);
    for (let start = 0; start < selected.length; start += 12) {
      const page = selected.slice(start, start + 12), width = 350, height = 490;
      const tiles = [];
      for (const [index, sample] of page.entries()) {
        const photo = await sharp(sample.image).resize(330, 410, { fit: "contain", background: "white" }).png().toBuffer();
        const caption = Buffer.from(`<svg width="350" height="70"><rect width="350" height="70" fill="white"/><text x="5" y="17" font-family="sans-serif" font-size="13">${escape(sample.id)}</text><text x="5" y="35" font-family="sans-serif" font-size="12">${escape(sample.expectedTitle).slice(0, 70)}</text><text x="5" y="53" font-family="sans-serif" font-size="12">${escape(sample.expectedAuthor)}</text></svg>`);
        const left = index % 4 * width, top = Math.floor(index / 4) * height;
        tiles.push({ input: photo, left: left + 10, top }, { input: caption, left, top: top + 415 });
      }
      await sharp({ create: { width: width * 4, height: height * Math.ceil(page.length / 4), channels: 3, background: "#dddddd" } })
        .composite(tiles).jpeg({ quality: 90 }).toFile(path.join(root, "review", `${group}-${start / 12 + 1}.jpg`));
    }
  }
}

async function main() {
  if (!["existing", "web"].includes(mode)) throw Error("Use existing or web");
  mkdirSync(path.join(root, "corpus"), { recursive: true });
  let samples: Sample[] = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
  const failures: { id: string; error: string }[] = [];
  if (mode === "existing") {
    if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required for read-only collection.");
    const connection = await createDatabase();
    try {
      const rows = await connection.db.select({ id: books.id, title: books.title, author: books.author, data: bookPhotos.data, key: bookPhotos.objectKey })
        .from(bookPhotos).innerJoin(books, eq(bookPhotos.bookId, books.id)).limit(100);
      const collected: Sample[] = [];
      for (const row of rows) {
        const id = `saved-book-${row.id}`;
        try {
          const image = await saveImage(id, row.data ? Buffer.from(row.data, "base64") : await createR2PhotoStore().get(row.key!));
          collected.push({ id, image, expectedTitle: row.title, expectedAuthor: row.author, group: "user-upload", source: `folio-book:${row.id}`, labelStatus: "pending-visual-review" });
        } catch (error) { failures.push({ id, error: error instanceof Error ? error.message : "Saved photo unavailable" }); }
      }
      // The operator requested existing photos first; this cohort excludes web cases.
      samples = collected;
    } finally { await connection.close(); }
  } else {
    const seeds: WebSource[] = JSON.parse(readFileSync(new URL("./web-sources.json", import.meta.url), "utf8"));
    const hosts = new Set(seeds.map(seed => new URL(seed.imageUrl).hostname));
    for (const seed of seeds) {
      try {
        const cached = path.join(root, "corpus", `${seed.id}.png`);
        const image = existsSync(cached) ? cached : await saveImage(seed.id, await download(seed.imageUrl, hosts));
        samples = samples.filter(sample => sample.id !== seed.id);
        samples.push({ id: seed.id, image, expectedTitle: seed.expectedTitle, expectedAuthor: seed.expectedAuthor, group: seed.group, source: seed.source, labelStatus: seed.labelStatus,
          expectedTitleAliases: seed.expectedTitleAliases });
        console.log(`Collected real-photo candidate ${seed.id}`);
      } catch (error) { failures.push({ id: seed.id, error: error instanceof Error ? error.message : "Photo unavailable" }); }
    }
    const catalog = [["The Great Gatsby", "F. Scott Fitzgerald"], ["Jane Eyre", "Charlotte Brontë"], ["Frankenstein", "Mary Shelley"],
      ["Dracula", "Bram Stoker"], ["The Picture of Dorian Gray", "Oscar Wilde"], ["Great Expectations", "Charles Dickens"]];
    for (const [index, [title, author]] of catalog.entries()) {
      const id = `catalog-${index + 1}`;
      try {
        const response = JSON.parse((await download(`https://htk3x7p5jf.ap-south-1.awsapprunner.com/api/autocomplete?search=${encodeURIComponent(title)}`,
          new Set(["htk3x7p5jf.ap-south-1.awsapprunner.com"]), 512_000)).toString()) as {
          results?: { Book_Id: number; BOOK_TITLE: string; authorName: string; BOOK_ISBN: string }[] };
        const record = response.results?.find(record => normalize(record.BOOK_TITLE).startsWith(normalize(title)) &&
          normalize(author).split(" ").filter(word => word.length > 1).every(word => normalize(record.authorName).includes(word)) &&
          /^97[89]\d{10}$/.test(record.BOOK_ISBN) && Number.isSafeInteger(record.Book_Id));
        if (!record) throw Error("No independently labelled catalog candidate found");
        const image = await saveImage(id, await download(`https://d9z6htgewkjtb.cloudfront.net/${record.BOOK_ISBN}.webp`, new Set(["d9z6htgewkjtb.cloudfront.net"])));
        samples = samples.filter(sample => sample.id !== id);
        samples.push({ id, image, expectedTitle: title, expectedAuthor: author, group: "catalog-baseline", source: `https://readings.com.pk/book/${record.Book_Id}`, labelStatus: "pending-visual-review" });
      } catch (error) { failures.push({ id, error: error instanceof Error ? error.message : "Catalog cover unavailable" }); }
    }
  }
  writeFileSync(manifest, JSON.stringify(samples, null, 2));
  writeFileSync(path.join(root, `collection-${mode}.json`), JSON.stringify({ collectedAt: new Date().toISOString(), samples: samples.length, failures }, null, 2));
  await contactSheets(samples);
  console.log(`Collected ${samples.length} saved corpus cases; ${failures.length} unavailable. Contact sheets: .folio-ocr/review/`);
  console.log("Labels require visual review before counting verified results. Database SELECTs / photo GETs only; no messages, imports or stock writes.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Collection failed"); process.exitCode = 1; });
