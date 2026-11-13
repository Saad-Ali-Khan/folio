import type Stripe from "stripe";
import { recordRefund, releaseCheckout } from "@/lib/order-service";
import { syncStripeCheckout } from "@/lib/checkout-recovery";
import { getDb } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    return Response.json(
      { error: "Stripe webhook is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing signature." }, { status: 400 });
  }

  const payload = await request.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    console.error("Invalid Stripe webhook signature", error);
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    const db = await getDb();
    if (event.type === "charge.refunded") {
      await recordRefund(db, await stripe.charges.retrieve(event.data.object.id));
    } else if (["checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) {
      const session = await stripe.checkout.sessions.retrieve((event.data.object as Stripe.Checkout.Session).id);
      await syncStripeCheckout(db,stripe,session);
      if (event.type === "checkout.session.async_payment_failed" && session.payment_status !== "paid" && session.metadata?.checkout_id) await releaseCheckout(db,session.metadata.checkout_id);
    }
    return Response.json({received:true});
  } catch(error) {
    console.error("Webhook reconciliation failed",error);
    return Response.json({error:"Webhook handling failed."},{status:500});
  }
}
