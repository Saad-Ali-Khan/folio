import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-24 text-center sm:px-6">
      <p className="text-xs uppercase tracking-[0.22em] text-accent">404</p>
      <h1 className="mt-3 font-display text-4xl">
        That page is off the shelf.
      </h1>
      <p className="mt-3 text-ink/70">
        The book or page you were looking for isn’t here.
      </p>
      <Link
        href="/"
        className="mt-8 inline-block rounded-full bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-accent"
      >
        Back to the catalog
      </Link>
    </div>
  );
}
