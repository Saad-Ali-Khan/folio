"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-24 text-center sm:px-6">
      <p className="text-xs uppercase tracking-[0.22em] text-accent">
        Something went wrong
      </p>
      <h1 className="mt-3 font-display text-4xl">We dropped the book.</h1>
      <p className="mt-3 text-ink/70">
        A temporary error stopped this page from loading. Try again in a
        moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-8 inline-block rounded-full bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}
