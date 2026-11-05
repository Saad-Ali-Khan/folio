import Link from "next/link";
import type { Book } from "@/lib/db/schema";
import { formatPrice } from "@/lib/format";
import { AddToCartButton } from "./add-to-cart";
import { BookCover } from "./book-cover";

export function BookCard({ book, eager }: { book: Book; eager?: boolean }) {
  return (
    <article className="group flex flex-col">
      <Link href={`/books/${book.slug}`} className="block">
        <BookCover
          src={book.coverUrl}
          title={book.title}
          eager={eager}
          className="aspect-[2/3] w-full shadow-sm ring-1 ring-ink/5 transition duration-300 group-hover:-translate-y-1 group-hover:shadow-lg"
          sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 220px"
        />
      </Link>
      <div className="mt-3 flex flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/books/${book.slug}`}
              className="block truncate font-display text-base leading-snug hover:text-accent"
            >
              {book.title}
            </Link>
            <p className="truncate text-sm text-ink/60">{book.author}</p>
          </div>
          <p className="shrink-0 text-sm font-medium">
            {formatPrice(book.priceCents)}
          </p>
        </div>
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
          label="Add"
          className="mt-3 w-full"
        />
      </div>
    </article>
  );
}
