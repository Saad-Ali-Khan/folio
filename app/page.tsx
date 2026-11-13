import { Suspense } from "react";
import { Catalog } from "@/components/catalog";
import { SearchForm } from "@/components/search-form";

type SearchParams = Promise<{
  q?: string | string[];
  page?: string | string[];
}>;

export default function HomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <section className="py-14 sm:py-20">
        <p className="text-xs uppercase tracking-[0.22em] text-accent">
          Independent bookstore
        </p>
        <h1 className="mt-4 max-w-2xl font-display text-4xl leading-[1.05] sm:text-6xl">
          Books worth keeping.
        </h1>
        <p className="mt-4 max-w-xl leading-relaxed text-ink/70">
          A small, carefully chosen shelf — classics, modern fiction, and a
          little nonfiction. Delivery within Pakistan.
        </p>
        <div className="mt-8 max-w-md">
          <SearchForm />
        </div>
      </section>

      <Suspense fallback={<CatalogSkeleton />}>
        <Catalog searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <section className="pb-20" aria-hidden="true">
      <div className="mb-6 border-t border-ink/10 pt-6">
        <div className="h-6 w-32 animate-pulse rounded bg-ink/10" />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-6 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index}>
            <div className="aspect-[2/3] w-full animate-pulse rounded-sm bg-ink/10" />
            <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-ink/10" />
            <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-ink/10" />
          </div>
        ))}
      </div>
    </section>
  );
}
