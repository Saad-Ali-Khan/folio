import {lookupImportMetadata} from "./import-metadata";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { books, discordCommands, type Book } from "@/lib/db/schema";
import type { InventoryVerb } from "@/lib/inventory-command";

export function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function toSlug(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function executeCommand(
  db: Database,
  messageId: string,
  channelId: string,
  verb: InventoryVerb,
  book: Book,
  qty: number | null,
): Promise<string | null> {
  if (verb === "GET") {
    return `${book.title} (${book.slug}): ${book.stock} in stock.`;
  }

  const summary = `${verb} ${book.slug} ${qty ?? 0}`;

  const outcome = await db.transaction(async (tx) => {
    const [logged] = await tx
      .insert(discordCommands)
      .values({ messageId, channelId, command: summary })
      .onConflictDoNothing({ target: discordCommands.messageId })
      .returning({ id: discordCommands.id });

    if (!logged) return { duplicate: true as const };

    await tx.execute(sql`select set_config('folio.stock_reason', ${summary}, true)`);
    const nextStock =
      verb === "SET"
        ? (qty ?? 0)
        : verb === "ADD"
          ? sql`${books.stock} + ${qty ?? 0}`
          : sql`${books.stock} - ${qty ?? 0}`;

    const [updated] = await tx
      .update(books)
      .set({ stock: nextStock })
      .where(and(eq(books.id, book.id), verb === "SOLD" ? gte(books.stock, qty ?? 0) : undefined))
      .returning({ stock: books.stock });

    if (!updated) throw new Error("Not enough stock. Check the quantity before recording a sale.");
    return { duplicate: false as const, stock: updated.stock };
  });

  if (outcome.duplicate) return null;

  return `OK ${book.slug}: stock ${outcome.stock} (was ${book.stock}).`;
}

export type BookMetadata = {
  title: string;
  author: string;
  isbn: string | null;
  coverUrl: string | null;
  coverWorkId?: string;
};

export function inventoryEditionKey(meta: BookMetadata): string | null {
  return meta.isbn ?? (meta.coverWorkId ? `manual-cover-${meta.coverWorkId.toLowerCase()}` : null);
}

export async function fetchMetadataByTitle(title:string):Promise<import("./import-metadata").ImportMetadata>{
 return await lookupImportMetadata({title}) ?? {title,author:"Unknown author",isbn:null,coverUrl:null,titleNote:"Metadata unavailable; review the title and author in inventory."};
}
export async function fetchMetadataByIsbn(isbn:string){return lookupImportMetadata({isbn});}

export async function createBook(
  db: Database,
  meta: BookMetadata,
  stock: number,
): Promise<{ title: string; slug: string; stock: number }> {
  const taken = new Set(
    (await db.select({ slug: books.slug }).from(books)).map((row) => row.slug),
  );
  const base = toSlug(meta.title) || `book-${randomBytes(3).toString("hex")}`;
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix++) slug = `${base}-${suffix}`;

  const [created] = await db
    .insert(books)
    .values({
      title: meta.title,
      author: meta.author,
      isbn: inventoryEditionKey(meta) ?? `manual-${randomBytes(5).toString("hex")}`,
      slug,
      priceCents: 0,
      stock,
      description: "",
      coverUrl: meta.coverUrl,
    })
    .returning({ title: books.title, slug: books.slug, stock: books.stock });

  return created;
}

export async function createBookFromTitle(
  db: Database,
  title: string,
  stock: number,
): Promise<{ title: string; slug: string; stock: number }> {
  return createBook(db, await fetchMetadataByTitle(title), stock);
}

export async function logScan(
  db: Database,
  messageId: string,
  channelId: string,
  isbn: string,
): Promise<boolean> {
  const [logged] = await db
    .insert(discordCommands)
    .values({ messageId, channelId, command: `SCAN ${isbn}` })
    .onConflictDoNothing({ target: discordCommands.messageId })
    .returning({ id: discordCommands.id });
  return Boolean(logged);
}

export async function importDiscordBook(db: Database, messageId: string, channelId: string, meta: BookMetadata, qty: number) {
 const editionKey = inventoryEditionKey(meta);
 return db.transaction(async tx => {
  const [claim] = await tx.insert(discordCommands).values({messageId, channelId, command: 'IMPORT ' + meta.title}).onConflictDoNothing().returning();
  if (!claim) return null;
  // Serialize imports of the same edition across different Discord messages.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${editionKey ?? meta.title.toLowerCase()}))`);
  const [existing] = await tx.select().from(books).where(editionKey ? eq(books.isbn, editionKey) : sql`lower(${books.title}) = ${meta.title.toLowerCase()}`).limit(1);
  if (existing) {
   const [updated] = await tx.update(books).set({stock: sql`${books.stock} + ${qty}`})
     .where(and(eq(books.id, existing.id), meta.coverWorkId ? eq(books.status, "draft") : undefined))
     .returning();
   if (!updated) throw new Error("The inventory entry changed. Send the photo again or scan the ISBN barcode.");
   return updated;
  }
  return createBook(tx as unknown as Database, meta, qty);
 });
}
