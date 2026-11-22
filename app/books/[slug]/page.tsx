import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { and, eq, gt } from "drizzle-orm";
import { AddToCartButton } from "@/components/add-to-cart";
import { BookCover } from "@/components/book-cover";
import { getDb } from "@/lib/db";
import { readWithRetry } from "@/lib/db/read";
import { bookEditions, bookPhotos, books } from "@/lib/db/schema";
import { formatPrice } from "@/lib/format";

// Book pages resolve their slug before rendering so unknown titles get a real
// 404 status instead of a streamed soft 404.
export const dynamic = "force-dynamic";

type Params = { slug: string };

const getBook = cache(async (slug: string) => {
  const db = await getDb();
  const [book] = await readWithRetry(() => db
    .select()
    .from(books)
    .where(and(eq(books.slug, slug), eq(books.status, "published"), gt(books.priceCents, 0)))
    .limit(1));
  return book ?? null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  const book = await getBook(slug);
  if (!book) return { title: "Book not found" };
  return {
    title: `${book.title} by ${book.author}`,
    description: book.description.slice(0, 160),
  };
}

export default async function BookPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  await connection();
  const book = await getBook(slug);
  if (!book) notFound();
  const db = await getDb();
  const [photo] = await readWithRetry(() => db.select({ bookId: bookPhotos.bookId })
    .from(bookPhotos).where(eq(bookPhotos.bookId, book.id)).limit(1));
  const [edition] = await readWithRetry(() => db.select({ publisher: bookEditions.publisher, translator: bookEditions.translator,
    language: bookEditions.language, edition: bookEditions.edition, reviewStatus: bookEditions.reviewStatus })
    .from(bookEditions).where(eq(bookEditions.bookId, book.id)).limit(1));
  const reviewed = edition?.reviewStatus === "reviewed";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <Link
        href="/"
        className="text-sm text-ink/60 underline-offset-4 transition-colors hover:text-accent hover:underline"
      >
        ← Back to catalog
      </Link>

      <div className="mt-8 grid gap-10 md:grid-cols-[300px_1fr] lg:gap-14">
        <div className="space-y-5">
          <BookCover
            src={book.coverUrl}
            title={book.title}
            eager
            className="aspect-[2/3] w-full max-w-[300px] shadow-md ring-1 ring-ink/5"
            sizes="(max-width: 768px) 60vw, 300px"
          />
          {photo && (
            <figure>
              {/* This endpoint serves an already resized WebP photograph. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/books/${encodeURIComponent(book.slug)}/photo`}
                alt={`Uploaded full cover of ${book.title}`}
                width={1200} height={1600}
                className="h-auto w-full max-w-[300px] rounded-sm"
                loading="lazy" />
              <figcaption className="mt-2 text-sm text-ink/60">Uploaded cover</figcaption>
            </figure>
          )}
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-accent">
            {book.author}
          </p>
          <h1 className="mt-3 font-display text-4xl leading-tight sm:text-5xl">
            {book.title}
          </h1>
          <p className="mt-4 text-2xl font-medium">
            {formatPrice(book.priceCents)}
          </p>
          <StockBadge stock={book.stock} />

          <p className="mt-6 max-w-prose leading-relaxed text-ink/75">
            {book.description}
          </p>

          <div className="mt-8">
            <AddToCartButton
              book={{
                id: book.id,
                slug: book.slug,
                title: book.title,
                author: book.author,
                priceCents: book.priceCents,
                coverUrl: book.coverUrl,
              }}
              disabled={book.stock <= 0}
              className="px-7 py-3"
            />
          </div>

          <dl className="mt-10 grid gap-4 border-t border-ink/10 pt-6 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink/50">ISBN</dt>
              <dd className="mt-0.5 font-mono text-xs">{book.isbn.startsWith("manual-") ? "Not verified" : book.isbn}</dd>
            </div>
            <div>
              <dt className="text-ink/50">Availability</dt>
              <dd className="mt-0.5">
                {book.stock > 0
                  ? "Ships in 1–2 business days"
                  : "Currently unavailable"}
              </dd>
            </div>
            {reviewed && ([['publisher', 'Publisher'], ['translator', 'Translator'], ['language', 'Language'], ['edition', 'Edition / printing']] as const).map(([key, label]) =>
              edition[key] ? <div key={key}><dt className="text-ink/50">{label}</dt><dd className="mt-0.5">{edition[key]}</dd></div> : null)}
            <div>
              <dt className="text-ink/50">Shipping</dt>
              <dd className="mt-0.5">Calculated at checkout</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) {
    return (
      <p className="mt-3 inline-flex rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
        Sold out
      </p>
    );
  }
  if (stock <= 5) {
    return (
      <p className="mt-3 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
        Only {stock} left
      </p>
    );
  }
  return (
    <p className="mt-3 inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-900">
      In stock
    </p>
  );
}
