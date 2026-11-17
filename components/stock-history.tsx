"use client";

import { useState } from "react";
import type { stockMovements } from "@/lib/db/schema";

type Movement = Omit<typeof stockMovements.$inferSelect, "createdAt"> & { createdAt: string };

export function StockHistory({ bookId, onExpired }: { bookId: number; onExpired: () => void }) {
  const [movements, setMovements] = useState<Movement[]>();
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(before?: number) {
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ bookId: String(bookId) });
      if (before !== undefined) query.set("before", String(before));
      const response = await fetch(`/api/admin/books/stock?${query}`, { cache: "no-store" });
      if (response.status === 401) { onExpired(); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMovements(current => before === undefined ? data.movements : [...(current ?? []), ...data.movements]);
      setNextBefore(data.nextBefore);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stock history could not load.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="stock-history-heading" className="mt-7 border-t border-ink/10 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="stock-history-heading" className="font-display text-xl">Stock history</h3>
        <button type="button" className="text-sm text-accent underline disabled:opacity-50"
          disabled={busy} onClick={() => void load()}>
          {movements ? "Refresh history" : "Load history"}
        </button>
      </div>
      {busy && <p role="status" className="mt-3 text-sm text-ink/60">Loading stock history…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {movements?.length === 0 && <p className="mt-3 text-sm text-ink/60">No stock movements recorded.</p>}
      {movements && movements.length > 0 && (
        <ol className="mt-3 divide-y divide-ink/10 text-sm">
          {movements.map(movement => (
            <li key={movement.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{movement.before} to {movement.after} copies ({movement.delta > 0 ? "+" : ""}{movement.delta})</p>
                <time className="text-xs text-ink/60" dateTime={movement.createdAt}>{new Date(movement.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-1 break-words text-ink/70">{movement.reason}</p>
            </li>
          ))}
        </ol>
      )}
      {nextBefore !== null && (
        <button type="button" disabled={busy} onClick={() => void load(nextBefore)}
          className="mt-3 text-sm text-accent underline disabled:opacity-50">Load older changes</button>
      )}
    </section>
  );
}
