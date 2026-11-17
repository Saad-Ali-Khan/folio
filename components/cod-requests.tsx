"use client";

import { useState, type FormEvent } from "react";
import type { codRequests } from "@/lib/db/schema";
import { formatPrice } from "@/lib/format";

type PendingRequest = Omit<typeof codRequests.$inferSelect, "expiresAt"> & { expiresAt: string };

export function CodRequests({ onApproved }: { onApproved: () => void }) {
  const [requests, setRequests] = useState<PendingRequest[]>();
  const [selected, setSelected] = useState<PendingRequest>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/cod", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setRequests(result.requests);
      setSelected(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load requests.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const fields = new FormData(event.currentTarget);
    setNotice("");
    setError("");
    if (String(fields.get("reference")).trim().toUpperCase() !== selected.id) {
      setError("The WhatsApp reference does not match the request you are reviewing.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/admin/cod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(fields)),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setRequests(previous => previous?.filter(request => request.id !== selected.id));
      setSelected(undefined);
      const total = formatPrice(result.totalCents);
      setNotice(result.addedToExisting
        ? `Books added to order #${result.orderId}. The new total is ${total}. Reply on WhatsApp with the updated total.`
        : `Order #${result.orderId} approved for ${total}. Reply to the buyer on WhatsApp to confirm.`);
      onApproved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-ink/10 bg-white/50 p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-2xl">COD requests</h2>
        <button type="button" disabled={busy} onClick={refresh} className="text-sm text-accent underline disabled:opacity-50">
          {requests ? "Refresh requests" : "Load requests"}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-accent">{notice}</p>}
      {requests?.length === 0 && <p className="mt-3 text-sm">No pending requests.</p>}
      {!!requests?.length && (
        <ul className="mt-3 divide-y divide-ink/10">
          {requests.map(request => (
            <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span><strong>{request.id}</strong> · {request.delivery.name} · {request.delivery.address.city}</span>
              <button type="button" disabled={busy} onClick={() => setSelected(request)} className="text-accent underline">Review</button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <form key={selected.id} onSubmit={approve} className="mt-4 space-y-3 rounded-lg border border-ink/10 p-4 text-sm">
          <h3 className="font-medium">Request {selected.id} · {formatPrice(selected.totalCents)}</h3>
          <p>{selected.delivery.name} · {selected.phone}</p>
          <p>{[selected.delivery.address.line1, selected.delivery.address.line2, selected.delivery.address.city].filter(Boolean).join(", ")}</p>
          <ul className="list-inside list-disc">
            {selected.lines.map(line => <li key={line.bookId}>{line.qty} × {line.title}</li>)}
          </ul>
          <p>Copy the reference and sender number from the incoming WhatsApp message.</p>
          <p>Follow-up requests for the same delivery details are added to the existing unshipped order, with shipping recalculated.</p>
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            <label>Reference from message
              <input name="reference" required maxLength={12} pattern="[A-Fa-f0-9]{12}" className="mt-1 w-full rounded border border-ink/20 bg-white p-2" />
            </label>
            <label>WhatsApp sender number
              <input name="sender" type="tel" required maxLength={30} className="mt-1 w-full rounded border border-ink/20 bg-white p-2" />
            </label>
          </fieldset>
          <button disabled={busy} className="rounded-full bg-ink px-4 py-2 text-cream disabled:opacity-50">Approve and reserve stock</button>
        </form>
      )}
    </section>
  );
}
