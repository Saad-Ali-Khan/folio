import { createDatabase } from "../lib/db";
import { eq, and, sql } from "drizzle-orm";
import { bookPhotos, photoObjects } from "../lib/db/schema";
import { copyPhoto, photoIdentity, reservePhotoRead, verifyPhoto } from "../lib/photo-budget";
import { createR2PhotoStore } from "../lib/r2-photo-store";
import { restorePhotoFallbacks } from "../lib/photo-rollback";
import { readFileSync } from "node:fs";
import { open, verifyRestore } from "./backup-lib";
import { preparePhotoReclamation, reclaimPhotoPayloads } from "./photo-reclamation-lib";

async function main() {
  const mode = process.argv[2] ?? "--plan";
  if (!["--plan", "--copy", "--verify", "--link", "--rollback", "--prepare-reclaim", "--reclaim"].includes(mode) || (mode === "--reclaim" ? process.argv.length !== 4 : process.argv.length > 3)) throw new Error("Use photos:migrate with --plan, --copy, --verify, --link, --rollback, --prepare-reclaim or --reclaim BACKUP_FILE.");
  const { db, close } = await createDatabase();
  try {
    if(mode === "--prepare-reclaim") {
      console.log(JSON.stringify(await preparePhotoReclamation(db)));
      console.log("Permanent copies prepared. Create a fresh verified backup before --reclaim; no payloads removed.");return;
    }
    if(mode === "--reclaim") {
      const key=Buffer.from(process.env.FOLIO_BACKUP_KEY?.trim()||readFileSync(".folio-backup-key","utf8").trim(),"base64");
      const snapshot=open(readFileSync(process.argv[3]),key);await verifyRestore(snapshot);
      console.log(JSON.stringify(await reclaimPhotoPayloads(db,snapshot)));
      console.log("PASS backed-up payloads reclaimed atomically; active title choices, stock and orders unchanged. R2 objects preserved.");return;
    }
    if (mode === "--rollback") {
      const result = await restorePhotoFallbacks(db);
      console.log(`PASS verified Neon fallbacks restored: ${result.photos} photos, ${result.choices} title choices. No stock changed. Disable PHOTO_STORAGE before deploying pre-R2 code.`);
      return;
    }
    const rows = await db.select().from(bookPhotos);
    const unique = new Map<string, Buffer>();
    for (const row of rows) {
      if (!row.data && row.objectKey) continue;
      const data = Buffer.from(row.data, "base64");
      if (data.toString("base64") !== row.data) throw new Error(`Photo ${row.bookId} has invalid base64; migration stopped.`);
      unique.set(photoIdentity(data), data);
    }
    console.log(`Plan: ${rows.length} listing photos, ${unique.size} unique inline objects to copy, ${[...unique.values()].reduce((sum, data) => sum + data.length, 0)} inline bytes. Originals are retained unless --reclaim is explicitly used.`);
    if (mode === "--plan") return;
    const store = createR2PhotoStore();
    if (mode === "--copy") {
      for (const data of unique.values()) {
        const result = await copyPhoto(db, data, store);
        console.log(result.upload ? "PASS copied and checksum verified" : "PASS already verified; no upload needed");
      }
    } else if (mode === "--verify") {
      // Includes uncertain objects, including photos since replaced/deleted in inventory.
      for (const object of await db.select().from(photoObjects)) {
        if(!object.key.startsWith("covers/"))continue;
        await reservePhotoRead(db);
        await verifyPhoto(db, object.key, await store.get(object.key));
        console.log("PASS reserved object checksum verified");
      }
    } else {
      for (const row of rows) {
        if (!row.data) continue;
        const data = Buffer.from(row.data, "base64"), key = photoIdentity(data);
        await reservePhotoRead(db);
        await verifyPhoto(db, key, await store.get(key));
        const linked = await db.update(bookPhotos).set({ objectKey: key }).where(and(eq(bookPhotos.bookId, row.bookId), eq(bookPhotos.data, row.data),
          row.objectKey ? eq(bookPhotos.objectKey, row.objectKey) : sql`${bookPhotos.objectKey} is null`)).returning();
        if (!linked.length) throw new Error("Photo changed during verification; retry the plan.");
        console.log("PASS verified R2 pointer linked; Neon original retained");
      }
    }
    console.log("Photo operation complete. No Neon originals deleted or stock changed. R2 serving requires the new deployed Worker.");
  } finally { await close(); }
}
main().catch(() => { console.error("Photo migration stopped. Check configuration, migrations and limits. Reservations and Neon originals retained; use --verify before retrying an uncertain upload. Credentials and remote response bodies are not logged."); process.exitCode = 1; });
