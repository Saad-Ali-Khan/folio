"use client";

import { useState, type FormEvent } from "react";
import { formatPrice } from "@/lib/format";
import { useCart } from "@/components/cart-provider";

const fieldClass = "mt-1 w-full rounded border border-ink/20 bg-white px-3 py-2 text-sm";

export function CodCheckout({ items, copyIds, total, onChanged }: {
  items: { id: number; qty: number }[];
  copyIds: string[];
  total: number;
  onChanged: () => void;
}) {
  const { approvedReference, trackCodRequest } = useCart();
  const [pending, setPending] = useState<{ reference: string; whatsappUrl: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fields, items, totalCents: total,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) onChanged();
        throw new Error(result.error ?? "Checkout is unavailable. Try again.");
      }
      if (typeof result.reference === "string" && typeof result.whatsappUrl === "string") {
        if (typeof result.statusToken === "string") {
          await trackCodRequest({ reference: result.reference, token: result.statusToken, copyIds });
        }
        setPending(result);
      } else {
        throw new Error("Checkout is unavailable. Try again.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout is unavailable. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pending && pending.reference !== approvedReference) {
    return (
      <section className="mt-5 space-y-3 border-t border-ink/10 pt-4">
        <h3 className="font-display text-lg">Send your request on WhatsApp</h3>
        <p className="text-sm">Send reference <strong>{pending.reference}</strong> from the number you entered. Once Folio approves the request, the ordered copies will come out of your cart.</p>
        <a href={pending.whatsappUrl} target="_blank" rel="noreferrer"
          className="block rounded-full bg-ink px-4 py-3 text-center text-sm font-medium text-cream hover:bg-accent">
          Confirm on WhatsApp
        </a>
        <button type="button" className="text-sm underline" onClick={() => setPending(undefined)}>Change delivery details</button>
      </section>
    );
  }

  return (
    <form className="mt-5 border-t border-ink/10 pt-4" onSubmit={submit}>
      <h3 className="font-display text-lg">Cash on delivery</h3>
      <p className="mt-2 text-sm text-ink/70">Adding to an unshipped order? Use the same WhatsApp number, name, and address. Folio will confirm your combined total on WhatsApp.</p>
      <fieldset disabled={busy} className="mt-3 space-y-3">
        <label className="block text-sm">Full name
          <input className={fieldClass} name="name" autoComplete="shipping name" required minLength={2} maxLength={120} />
        </label>
        <label className="block text-sm">Street address
          <input className={fieldClass} name="line1" autoComplete="shipping address-line1" required minLength={8} maxLength={200} />
        </label>
        <label className="block text-sm">Apartment, area or landmark (optional)
          <input className={fieldClass} name="line2" autoComplete="shipping address-line2" maxLength={200} />
        </label>
        <label className="block text-sm">Delivery city or town in Pakistan
          <input className={fieldClass} name="city" autoComplete="shipping address-level2" required minLength={2} maxLength={80} />
        </label>
        <label className="block text-sm">WhatsApp mobile number
          <input className={fieldClass} name="phone" type="tel" autoComplete="tel" placeholder="03XX XXXXXXX"
            maxLength={30} required />
        </label>
        {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button className="w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-cream hover:bg-accent disabled:bg-ink/30">
          {busy ? "Please wait…" : `Prepare COD request · ${formatPrice(total)}`}
        </button>
      </fieldset>
    </form>
  );
}
