import { eq } from "drizzle-orm";
import { applyCheckoutSession, CheckoutError, reserveCheckout, releaseCheckout } from "@/lib/order-service";
import { getDb } from "@/lib/db";
import { checkouts } from "@/lib/db/schema";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { appOrigin } from "@/lib/admin-auth";
import { clientKey } from "@/lib/request-limits";

const MAX_QTY_PER_BOOK = 10;
const MAX_DISTINCT_BOOKS = 50;

type IncomingItem = { id: number; qty: number };

function parseItems(payload: unknown): IncomingItem[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  if (items.length > MAX_DISTINCT_BOOKS) return null;

  const parsed: IncomingItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) return null;
    const id = Number((raw as { id?: unknown }).id);
    const qty = Number((raw as { qty?: unknown }).qty);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_BOOK) {
      return null;
    }
    const existing = parsed.find((item) => item.id === id);
    if (existing) { existing.qty += qty; if (existing.qty > MAX_QTY_PER_BOOK) return null; }
    else parsed.push({ id, qty });
  }
  return parsed;
}

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return Response.json(
      {
        error:
          "Stripe is not configured. Add STRIPE_SECRET_KEY to .env and restart the server.",
      },
      { status: 503 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const items = parseItems(payload);
  if (!items) {
    return Response.json(
      { error: "Your cart is empty or invalid." },
      { status: 400 },
    );
  }

  const id = (payload as { attemptId?: unknown }).attemptId;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    return Response.json({ error: "Refresh your cart to start checkout." }, { status: 400 });
  }
  const origin = appOrigin(request);
  const client = clientKey(request);
  if (!origin || !client || (process.env.NODE_ENV === "production" && !process.env.STRIPE_WEBHOOK_SECRET)) {
    return Response.json({ error: "Checkout is unavailable right now." }, { status: 503 });
  }

  const db = await getDb();
  let checkout;
  try {
    checkout = await reserveCheckout(db, items, origin, { id, clientKey: client });
  } catch (error) {
    if (error instanceof CheckoutError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Checkout reservation failed", error);
    return Response.json({ error: "Unable to reserve stock right now." }, { status: 503 });
  }
  try {
    const stripe = getStripe();
    if (!checkout.stripeSessionId && (checkout.params.expires_at ?? 0) <= Date.now() / 1000 + 1800) {
      return Response.json({ error: "This checkout ended. Try again to start a new one." }, { status: 410 });
    }
    const session = checkout.stripeSessionId
      ? await stripe.checkout.sessions.retrieve(checkout.stripeSessionId)
      : await stripe.checkout.sessions.create(checkout.params, { idempotencyKey: checkout.id });
    await db.update(checkouts).set({stripeSessionId:session.id}).where(eq(checkouts.id,checkout.id));
    if (session.payment_status === "paid") {
      return Response.json({ url: `${origin}/checkout/success?session_id=${encodeURIComponent(session.id)}` });
    }
    if (session.status === "expired") {
      await applyCheckoutSession(db, session);
      return Response.json({ error: "This checkout expired. Try again to start a new one." }, { status: 410 });
    }
    if (!session.url) throw new Error("Checkout URL unavailable");
    return Response.json({url:session.url});
  } catch(error) {
    // Connection failures can mean Stripe created the session. Keep the hold
    // until reconciliation proves that payment cannot still occur.
    if (!checkout.stripeSessionId && error && typeof error === "object" && "type" in error &&
        error.type === "StripeInvalidRequestError" && "statusCode" in error && error.statusCode === 400) {
      await releaseCheckout(db, checkout.id);
      return Response.json({ error: "Checkout could not start. Try again later." }, { status: 410 });
    }
    console.error("Checkout creation failed; reconcile reservation",checkout.id,error);
    return Response.json({error:"Checkout could not start. Please try again later."},{status:502});
  }
}
