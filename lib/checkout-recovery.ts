import type Stripe from "stripe";
import { and, eq, lte } from "drizzle-orm";
import type { Database } from "./db";
import { checkouts, discordStockChoices, requestLimits, titleChoices } from "./db/schema";
import { applyCheckoutSession } from "./order-service";

export async function syncStripeCheckout(db: Database, stripe: Stripe, session: Stripe.Checkout.Session) {
  let charge: Stripe.Charge | undefined;
  if (session.payment_status === "paid" && typeof session.payment_intent === "string") {
    const intent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ["latest_charge"] });
    charge = typeof intent.latest_charge === "string"
      ? await stripe.charges.retrieve(intent.latest_charge)
      : intent.latest_charge ?? undefined;
  }
  await applyCheckoutSession(db, session, charge);
}

export async function reconcileCheckouts(db: Database, stripe: Stripe, cancelId?: string) {
  const held = await db.select().from(checkouts).where(and(
    eq(checkouts.status, "held"),
    cancelId ? eq(checkouts.id, cancelId) : lte(checkouts.createdAt, new Date(Date.now() - 2 * 60_000)),
  ));
  if (cancelId && !held.length) throw new Error("No active checkout matches that ID.");

  let unresolved = 0;
  for (const checkout of held) {
    try {
      let sessionId = checkout.stripeSessionId;
      if (!sessionId) {
        const created = Math.floor(checkout.createdAt.getTime() / 1000);
        for await (const session of stripe.checkout.sessions.list({
          created: { gte: created - 300, lte: checkout.params.expires_at ?? created + 3600 },
          limit: 100,
        })) {
          if (session.metadata?.checkout_id === checkout.id) {
            sessionId = session.id;
            break;
          }
        }
      }
      if (!sessionId) throw new Error("Stripe session outcome unknown. Stock remains held for review.");

      let session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status === "open" && (cancelId || session.expires_at <= Date.now() / 1000)) {
        session = await stripe.checkout.sessions.expire(sessionId);
      }
      await syncStripeCheckout(db, stripe, session);
      if (session.status !== "open") console.log("Checkout reconciled", checkout.id, session.status, session.payment_status);
    } catch (error) {
      if (cancelId) throw error;
      unresolved++;
      console.error("Checkout needs reconciliation", checkout.id, error instanceof Error ? error.message : error);
    }
  }

  if (!cancelId) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await db.delete(requestLimits).where(lte(requestLimits.expiresAt, cutoff));
    await db.delete(discordStockChoices).where(lte(discordStockChoices.expiresAt, cutoff));
    await db.delete(titleChoices).where(lte(titleChoices.expiresAt, cutoff));
  }
  return unresolved;
}
