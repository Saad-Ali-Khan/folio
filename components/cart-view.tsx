"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BookCover } from "@/components/book-cover";
import { useCart } from "@/components/cart-provider";
import { formatPrice } from "@/lib/format";

type LiveBook = { id: number; priceCents: number; stock: number };

export function CartView() {
  const { items, ready, setQty, remove } = useCart();
  const [availability, setAvailability] = useState<{
    idsKey: string;
    books: Record<number, LiveBook>;
  } | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idsKey = useMemo(
    () => items.map((item) => item.id).join(","),
    [items],
  );

  useEffect(() => {
    if (!idsKey) return;

    let cancelled = false;

    fetch(`/api/books?ids=${idsKey}`)
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("Could not load availability")),
      )
      .then((data: { books?: LiveBook[] }) => {
        if (cancelled) return;
        setAvailability({
          idsKey,
          books: Object.fromEntries(
            (data.books ?? []).map((book) => [book.id, book]),
          ),
        });
      })
      .catch(() => {
        // Checkout revalidates against the database, so stale prices are safe.
      });

    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const live =
    availability && availability.idsKey === idsKey ? availability.books : {};
  const hydrated = idsKey === "" || availability?.idsKey === idsKey;

  const detailed = items.map((item) => {
    const current = live[item.id];
    return {
      ...item,
      priceCents: current?.priceCents ?? item.priceCents,
      stock: current?.stock,
      unavailable: hydrated && !current,
      overStock: current ? item.qty > current.stock : false,
    };
  });

  const purchasable = detailed.filter((item) => !item.unavailable);
  const total = purchasable.reduce(
    (sum, item) => sum + item.priceCents * item.qty,
    0,
  );
  const blocked = detailed.some((item) => item.unavailable || item.overStock);

  async function handleCheckout() {
    setError(null);
    setCheckingOut(true);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: purchasable.map(({ id, qty }) => ({ id, qty })),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Checkout is unavailable right now.");
      }
      window.location.assign(data.url);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Something went wrong. Please try again.",
      );
      setCheckingOut(false);
    }
  }

  if (!ready) {
    return (
      <div className="space-y-5" aria-hidden="true">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="flex gap-4 border-b border-ink/10 py-5">
            <div className="h-28 w-20 animate-pulse rounded-sm bg-ink/10" />
            <div className="flex-1 space-y-3">
              <div className="h-5 w-1/2 animate-pulse rounded bg-ink/10" />
              <div className="h-3 w-1/4 animate-pulse rounded bg-ink/10" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-ink/10 bg-white/50 p-10 text-center">
        <p className="font-display text-2xl">Your cart is empty.</p>
        <p className="mt-2 text-sm text-ink/60">
          The shelf is waiting. Go find something worth keeping.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-full bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-accent"
        >
          Browse the catalog
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
      <ul className="border-t border-ink/10">
        {detailed.map((item) => (
          <li key={item.id} className="flex gap-4 border-b border-ink/10 py-5">
            <Link href={`/books/${item.slug}`} className="shrink-0">
              <BookCover
                src={item.coverUrl}
                title={item.title}
                className="h-28 w-20"
                sizes="80px"
              />
            </Link>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/books/${item.slug}`}
                    className="font-display text-lg leading-snug hover:text-accent"
                  >
                    {item.title}
                  </Link>
                  <p className="text-sm text-ink/60">{item.author}</p>
                  {item.unavailable && (
                    <p className="mt-1 text-xs font-medium text-red-700">
                      No longer available
                    </p>
                  )}
                  {item.overStock && (
                    <p className="mt-1 text-xs font-medium text-red-700">
                      Only {item.stock} left in stock
                    </p>
                  )}
                </div>
                <p className="shrink-0 text-sm font-medium">
                  {formatPrice(item.priceCents)}
                </p>
              </div>

              <div className="mt-auto flex items-center justify-between pt-3">
                <div className="flex items-center rounded-full border border-ink/15">
                  <button
                    type="button"
                    onClick={() => setQty(item.id, item.qty - 1)}
                    disabled={item.qty <= 1}
                    aria-label={`Decrease quantity of ${item.title}`}
                    className="px-3 py-1 text-sm disabled:text-ink/30"
                  >
                    −
                  </button>
                  <span className="min-w-8 text-center text-sm">{item.qty}</span>
                  <button
                    type="button"
                    onClick={() => setQty(item.id, item.qty + 1)}
                    disabled={item.qty >= 10}
                    aria-label={`Increase quantity of ${item.title}`}
                    className="px-3 py-1 text-sm disabled:text-ink/30"
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  className="text-xs text-ink/50 underline-offset-2 transition-colors hover:text-red-700 hover:underline"
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <aside className="h-fit rounded-lg border border-ink/10 bg-white/60 p-6">
        <h2 className="font-display text-xl">Summary</h2>
        <div className="mt-4 flex justify-between text-sm">
          <span className="text-ink/60">Subtotal</span>
          <span className="font-medium">{formatPrice(total)}</span>
        </div>
        <p className="mt-1 text-xs text-ink/50">
          Shipping calculated at checkout.
        </p>

        {blocked && (
          <p className="mt-3 text-xs text-red-700">
            Adjust the highlighted quantities to continue.
          </p>
        )}
        {error && (
          <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleCheckout}
          disabled={checkingOut || blocked || purchasable.length === 0}
          className="mt-5 w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-cream transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:bg-ink/20"
        >
          {checkingOut ? "Redirecting…" : "Checkout"}
        </button>
        <p className="mt-3 text-center text-xs text-ink/50">
          Secure payment via Stripe
        </p>
        <Link
          href="/"
          className="mt-4 block text-center text-xs text-ink/60 underline-offset-2 hover:text-accent hover:underline"
        >
          Continue shopping
        </Link>
      </aside>
    </div>
  );
}
