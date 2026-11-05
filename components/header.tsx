"use client";

import Link from "next/link";
import { useCart } from "./cart-provider";

export function Header() {
  const { count, ready } = useCart();

  return (
    <header className="sticky top-0 z-20 border-b border-ink/10 bg-cream/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link
          href="/"
          className="font-display text-2xl leading-none tracking-tight"
        >
          Folio<span className="text-accent">.</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <Link
            href="/"
            className="text-ink/70 transition-colors hover:text-accent"
          >
            Catalog
          </Link>
          <Link
            href="/cart"
            className="rounded-full border border-ink/15 px-4 py-1.5 font-medium transition-colors hover:border-accent hover:text-accent"
          >
            Cart{ready && count > 0 ? ` (${count})` : ""}
          </Link>
        </nav>
      </div>
    </header>
  );
}
