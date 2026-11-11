import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

    const nextStock =
      verb === "SET"
        ? (qty ?? 0)
        : verb === "ADD"
          ? sql`${books.stock} + ${qty ?? 0}`
          : sql`greatest(${books.stock} - ${qty ?? 0}, 0)`;

    const [updated] = await tx
      .update(books)
      .set({ stock: nextStock })
      .where(eq(books.id, book.id))
      .returning({ stock: books.stock });

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
};

export async function fetchMetadataByTitle(
  title: string,
): Promise<BookMetadata> {
  const fallback: BookMetadata = {
    title,
    author: "Unknown author",
    isbn: null,
    coverUrl: null,
  };
  try {
    const response = await fetch(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) return fallback;
    const data = (await response.json()) as {
      docs?: {
        title?: string;
        author_name?: string[];
        isbn?: string[];
        cover_i?: number;
      }[];
    };
    const doc = data.docs?.[0];
    if (!doc) return fallback;
    const isbn = doc.isbn?.[0] ?? null;
    return {
      title: doc.title?.trim() || title,
      author: doc.author_name?.[0] ?? fallback.author,
      isbn,
      coverUrl: isbn
        ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`
        : doc.cover_i
          ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
          : null,
    };
  } catch {
    return fallback;
  }
}

export async function fetchMetadataByIsbn(
  isbn: string,
): Promise<BookMetadata | null> {
  try {
    const response = await fetch(
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      docs?: {
        title?: string;
        author_name?: string[];
        isbn?: string[];
        cover_i?: number;
      }[];
    };
    const doc = data.docs?.[0];
    if (!doc?.title) return null;
    const coverIsbn =
      doc.isbn?.find((value) => value.replace(/[-\s]/g, "") === isbn) ?? isbn;
    return {
      title: doc.title.trim(),
      author: doc.author_name?.[0] ?? "Unknown author",
      isbn: coverIsbn,
      coverUrl: doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
        : `https://covers.openlibrary.org/b/isbn/${coverIsbn}-L.jpg`,
    };
  } catch {
    return null;
  }
}

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
      isbn: meta.isbn ?? `manual-${randomBytes(5).toString("hex")}`,
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
