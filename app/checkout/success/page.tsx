import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ClearCart } from "@/components/clear-cart";
import { formatPrice } from "@/lib/format";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

export const metadata: Metadata = {
  title: "Order confirmed",
};

type SearchParams = Promise<{ session_id?: string | string[] }>;

type OrderLine = { name: string; qty: number; amount: number };

export default function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <Suspense fallback={<SummarySkeleton />}>
        <OrderSummary searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function OrderSummary({ searchParams }: { searchParams: SearchParams }) {
  const { session_id } = await searchParams;
  const sessionId = typeof session_id === "string" ? session_id : null;

  if (!sessionId) {
    return (
      <Message
        title="No order to show"
        body="This page is only reachable after a checkout."
      />
    );
  }

  if (!isStripeConfigured()) {
    return (
      <Message
        title="Stripe is not configured"
        body="Add STRIPE_SECRET_KEY to .env, restart the server, and try checkout again."
      />
    );
  }

  let email: string | null = null;
  let total = 0;
  let lines: OrderLine[] = [];
  let paid = false;

  try {
    await connection();
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });
    email = session.customer_details?.email ?? session.customer_email ?? null;
    total = session.amount_total ?? 0;
    paid = session.payment_status === "paid";
    lines = (session.line_items?.data ?? []).map((line) => ({
      name: line.description ?? "Book",
      qty: line.quantity ?? 1,
      amount: line.amount_total,
    }));
  } catch (error) {
    console.error("Unable to load checkout session", error);
    return (
      <Message
        title="We could not load this order"
        body="The confirmation link may have expired. Check your email for a receipt, or contact us."
      />
    );
  }

  return (
    <div>
      {paid && <ClearCart />}
      <p className="text-xs uppercase tracking-[0.22em] text-accent">
        Order confirmed
      </p>
      <h1 className="mt-3 font-display text-4xl sm:text-5xl">
        {paid ? "Thank you." : "Payment processing."}
      </h1>
      <p className="mt-3 leading-relaxed text-ink/70">
        {paid
          ? `A receipt is on its way${email ? ` to ${email}` : ""}. Your books ship within 1–2 business days.`
          : "Stripe is still confirming your payment. Refresh in a moment to see the updated status."}
      </p>

      {lines.length > 0 && (
        <ul className="mt-8 divide-y divide-ink/10 border-y border-ink/10">
          {lines.map((line, index) => (
            <li
              key={`${line.name}-${index}`}
              className="flex items-baseline justify-between gap-4 py-3 text-sm"
            >
              <span className="min-w-0 truncate">
                {line.name}{" "}
                <span className="text-ink/50">× {line.qty}</span>
              </span>
              <span className="shrink-0 font-medium">
                {formatPrice(line.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-between text-base font-medium">
        <span>Total</span>
        <span>{formatPrice(total)}</span>
      </div>

      <p className="mt-8 text-xs text-ink/50">
        Order reference:{" "}
        <span className="font-mono">{sessionId.slice(0, 20)}…</span>
      </p>

      <Link
        href="/"
        className="mt-8 inline-block rounded-full bg-ink px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-accent"
      >
        Continue browsing
      </Link>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white/60 p-8 text-center">
      <h1 className="font-display text-2xl">{title}</h1>
      <p className="mt-2 text-sm text-ink/70">{body}</p>
      <Link
        href="/"
        className="mt-6 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
      >
        Back to the catalog
      </Link>
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-3 w-32 animate-pulse rounded bg-ink/10" />
      <div className="h-10 w-2/3 animate-pulse rounded bg-ink/10" />
      <div className="h-4 w-full animate-pulse rounded bg-ink/10" />
      <div className="h-24 w-full animate-pulse rounded bg-ink/10" />
    </div>
  );
}
