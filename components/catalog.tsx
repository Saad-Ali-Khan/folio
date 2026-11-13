import Link from "next/link";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { and, eq, gt, count, ilike, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books, type Book } from "@/lib/db/schema";
import { BookCard } from "./book-card";

type SearchParams = Promise<{
  q?: string | string[];
  page?: string | string[];
}>;

const PER_PAGE = 12;

function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-parchment px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

export async function Catalog({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query =
    typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const requestedPage =
    typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  // Readings must never be baked into the static shell, and the embedded
  // PGlite driver reads the clock while querying.
  await connection();

  let rows: Book[] = [];
  let total = 0;
  let failed = false;

  try {
    const db = await getDb();
    const searchFilter = query
      ? or(ilike(books.title, `%${query}%`), ilike(books.author, `%${query}%`))
      : undefined;

    const filter = and(eq(books.status, "published"), gt(books.priceCents, 0), searchFilter);
    const [bookRows, totalRows] = await Promise.all([
      db
        .select()
        .from(books)
        .where(filter)
        .orderBy(books.title)
        .limit(PER_PAGE)
        .offset((page - 1) * PER_PAGE),
      db.select({ value: count() }).from(books).where(filter),
    ]);

    rows = bookRows;
    total = totalRows[0]?.value ?? 0;
  } catch (error) {
    console.error("Catalog query failed", error);
    failed = true;
  }

  if (failed) {
    return (
      <section className="mb-16 rounded-lg border border-ink/10 bg-white/60 p-6">
        <h2 className="font-display text-xl">The catalog is not ready yet</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink/70">
          Run <Cmd>npm run db:generate</Cmd>, then <Cmd>npm run db:setup</Cmd>{" "}
          and <Cmd>npm run db:seed</Cmd>, then reload this page. If you set{" "}
          <Cmd>DATABASE_URL</Cmd>, make sure that database is reachable.
        </p>
      </section>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const start = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const end = Math.min(page * PER_PAGE, total);

  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (target > 1) params.set("page", String(target));
    const queryString = params.toString();
    return queryString ? `/?${queryString}` : "/";
  };

  return (
    <section className="pb-20">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2 border-t border-ink/10 pt-6">
        <h2 className="font-display text-2xl">
          {query ? `Results for “${query}”` : "The shelf"}
        </h2>
        <p className="text-sm text-ink/60">
          {total === 0 ? "No books" : `Showing ${start}–${end} of ${total}`}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-ink/10 bg-white/50 p-10 text-center">
          <p className="font-display text-xl">
            Nothing on the shelf matches that.
          </p>
          <p className="mt-2 text-sm text-ink/60">
            Try a different title or author, or browse everything.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Clear search
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-6 lg:grid-cols-4">
          {rows.map((book, index) => (
            <BookCard key={book.id} book={book} eager={index < 4} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <nav
          className="mt-12 flex items-center justify-center gap-4 text-sm"
          aria-label="Pagination"
        >
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="rounded-full border border-ink/15 px-4 py-1.5 transition-colors hover:border-accent hover:text-accent"
            >
              Previous
            </Link>
          ) : (
            <span className="rounded-full border border-transparent px-4 py-1.5 text-ink/30">
              Previous
            </span>
          )}
          <span className="text-ink/60">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={pageHref(page + 1)}
              className="rounded-full border border-ink/15 px-4 py-1.5 transition-colors hover:border-accent hover:text-accent"
            >
              Next
            </Link>
          ) : (
            <span className="rounded-full border border-transparent px-4 py-1.5 text-ink/30">
              Next
            </span>
          )}
        </nav>
      )}
    </section>
  );
}
