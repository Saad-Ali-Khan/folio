import { eq, or } from "drizzle-orm";
import { createDatabase } from "../lib/db";
import { books } from "../lib/db/schema";

const usage = `Usage:
  npm run books -- list
  npm run books -- add --title "Piranesi" --author "Susanna Clarke" --isbn 9781635575637 \\
    --price 17.99 --stock 7 [--slug piranesi] [--description "..."] [--cover "https://..."]
  npm run books -- remove <slug|isbn|id>
  npm run books -- edit <slug|isbn|id> [--title ...] [--author ...] [--price 12.99]
    [--stock 5] [--description "..."] [--slug new-slug] [--isbn 978...] [--cover "https://..."]
  npm run books -- set-stock <slug|isbn|id> <qty>

--price is in PKR. --stock defaults to 0. --cover defaults to the Open
Library cover for the ISBN.`;

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]) {
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  return { flags, positional };
}

function value(flags: Flags, key: string) {
  const raw = flags[key];
  return typeof raw === "string" ? raw : undefined;
}

function required(flags: Flags, key: string) {
  const raw = value(flags, key);
  if (!raw) throw new Error(`Missing --${key}.`);
  return raw;
}

function toSlug(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePrice(raw: string) {
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("--price expects a positive amount in PKR, e.g. 12.99.");
  }
  return Math.round(price * 100);
}

function parseStock(raw: string) {
  const stock = Number(raw);
  if (!Number.isInteger(stock) || stock < 0) {
    throw new Error("--stock must be a whole number of 0 or more.");
  }
  return stock;
}

function pgErrorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current) return String((current as { code: unknown }).code);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function findBook(
  db: Awaited<ReturnType<typeof createDatabase>>["db"],
  identifier: string,
) {
  const id = Number(identifier);
  const conditions = [
    eq(books.slug, identifier),
    eq(books.isbn, identifier.replace(/[-\s]/g, "")),
  ];
  if (Number.isInteger(id) && id > 0 && id <= 2147483647) {
    conditions.push(eq(books.id, id));
  }

  const [book] = await db
    .select()
    .from(books)
    .where(or(...conditions))
    .limit(1);
  return book;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const { db, close } = await createDatabase();

  try {
    if (command === "publish" || command === "draft") {
      const book = await findBook(db, positional[0] ?? "");
      if (!book) throw new Error("Book not found.");
      if (command === "publish" && (book.priceCents <= 0 || book.author === "Unknown author")) throw new Error("Set price and author before publishing.");
      await db.update(books).set({status: command === "publish" ? "published" : "draft"}).where(eq(books.id, book.id));
      console.log(command === "publish" ? "Book published." : "Book moved to drafts.");
      return;
    }
    if (command === "list") {
      const rows = await db
        .select()
        .from(books)
        .orderBy(books.author, books.title);

      if (rows.length === 0) {
        console.log("No books. Run `npm run db:seed` to add the sample catalog.");
        return;
      }

      console.log(
        ["id", "status", "stock", "price", "slug", "title — author"].join("\t"),
      );
      for (const book of rows) {
        console.log(
          [
            book.id,
            book.status,
            book.stock,
            `PKR ${(book.priceCents / 100).toFixed(2)}`,
            book.slug,
            `${book.title} — ${book.author}`,
          ].join("\t"),
        );
      }
      console.log(`\n${rows.length} book(s).`);
      return;
    }

    if (command === "add") {
      const title = required(flags, "title").trim();
      const author = required(flags, "author").trim();
      const isbn = required(flags, "isbn").replace(/[-\s]/g, "");
      if (!/^\d{10}$|^\d{13}$/.test(isbn)) {
        throw new Error("--isbn must be 10 or 13 digits (hyphens allowed).");
      }

      const priceCents = parsePrice(required(flags, "price"));
      const stock = parseStock(value(flags, "stock") ?? "0");

      const slug = (value(flags, "slug") ?? toSlug(title)).trim();
      if (!slug) throw new Error("Could not derive a slug; pass --slug.");

      let inserted: { id: number; slug: string; title: string };
      try {
        [inserted] = await db
          .insert(books)
          .values({
            title,
            author,
            isbn,
            slug,
            priceCents,
            stock,
            description: value(flags, "description") ?? "",
            coverUrl:
              value(flags, "cover") ??
              `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
          })
          .returning({ id: books.id, slug: books.slug, title: books.title });
      } catch (error) {
        if (pgErrorCode(error) === "23505") {
          throw new Error(
            `A book with ISBN ${isbn} or slug "${slug}" already exists.`,
          );
        }
        throw error;
      }

      console.log(`Added "${inserted.title}" (#${inserted.id}) at /books/${inserted.slug}.`);
      return;
    }

    if (command === "edit" || command === "update") {
      const identifier = positional[0];
      if (!identifier) throw new Error(`Pass a slug, ISBN, or id.\n\n${usage}`);

      const book = await findBook(db, identifier);
      if (!book) throw new Error(`No book matches "${identifier}".`);

      const changes: Partial<typeof books.$inferInsert> = {};

      const title = value(flags, "title");
      if (title !== undefined) {
        if (!title.trim()) throw new Error("--title cannot be empty.");
        changes.title = title.trim();
      }

      const author = value(flags, "author");
      if (author !== undefined) {
        if (!author.trim()) throw new Error("--author cannot be empty.");
        changes.author = author.trim();
      }

      const description = value(flags, "description");
      if (description !== undefined) changes.description = description;

      const price = value(flags, "price");
      if (price !== undefined) changes.priceCents = parsePrice(price);

      const stock = value(flags, "stock");
      if (stock !== undefined) changes.stock = parseStock(stock);

      const cover = value(flags, "cover");
      if (cover !== undefined) changes.coverUrl = cover || null;

      const slug = value(flags, "slug");
      if (slug !== undefined) {
        const normalized = toSlug(slug);
        if (!normalized) throw new Error("--slug must contain letters or numbers.");
        changes.slug = normalized;
      }

      const isbn = value(flags, "isbn");
      if (isbn !== undefined) {
        const digits = isbn.replace(/[-\s]/g, "");
        if (!/^\d{10}$|^\d{13}$/.test(digits)) {
          throw new Error("--isbn must be 10 or 13 digits (hyphens allowed).");
        }
        changes.isbn = digits;
      }

      if (Object.keys(changes).length === 0) {
        throw new Error(
          "Nothing to change. Pass at least one of --title, --author, --price, --stock, --description, --slug, --isbn, or --cover.",
        );
      }

      try {
        await db.update(books).set(changes).where(eq(books.id, book.id));
      } catch (error) {
        if (pgErrorCode(error) === "23505") {
          throw new Error("Another book already uses that ISBN or slug.");
        }
        throw error;
      }

      console.log(
        `Updated "${changes.title ?? book.title}" (${changes.slug ?? book.slug}).`,
      );
      return;
    }

    if (command === "set-stock") {
      const identifier = positional[0] ?? value(flags, "slug") ?? value(flags, "isbn") ?? value(flags, "id");
      const qty = Number(positional[1] ?? value(flags, "stock"));
      if (!identifier) throw new Error(`Pass a slug, ISBN, or id.\n\n${usage}`);
      if (!Number.isInteger(qty) || qty < 0) {
        throw new Error("Pass a whole number of 0 or more as the quantity.");
      }

      const book = await findBook(db, identifier);
      if (!book) throw new Error(`No book matches "${identifier}".`);

      await db.update(books).set({ stock: qty }).where(eq(books.id, book.id));
      console.log(`"${book.title}" stock is now ${qty}.`);
      return;
    }

    if (command === "remove" || command === "delete") {
      const identifier = positional[0] ?? value(flags, "slug") ?? value(flags, "isbn") ?? value(flags, "id");
      if (!identifier) throw new Error(`Pass a slug, ISBN, or id.\n\n${usage}`);

      const book = await findBook(db, identifier);
      if (!book) throw new Error(`No book matches "${identifier}".`);

      try {
        await db.delete(books).where(eq(books.id, book.id));
      } catch (error) {
        if (pgErrorCode(error) === "23503") {
          throw new Error(
            `"${book.title}" appears in past orders and cannot be deleted. Set its stock to 0 instead to stop selling it.`,
          );
        }
        throw error;
      }

      console.log(`Removed "${book.title}" (${book.slug}).`);
      return;
    }

    throw new Error(`Unknown command "${command ?? ""}".\n\n${usage}`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
