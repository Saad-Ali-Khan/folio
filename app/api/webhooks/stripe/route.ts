import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books, orderItems, orders } from "@/lib/db/schema";
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

  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return Response.json({ received: true });
  }

  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ["data.price.product"],
      limit: 100,
    });

    const cart = lineItems.data.flatMap((line) => {
      const product = line.price?.product;
      const bookId =
        typeof product === "object" && product !== null && "metadata" in product
          ? Number(product.metadata?.book_id)
          : Number.NaN;
      const qty = line.quantity ?? 0;
      return Number.isInteger(bookId) && bookId > 0 && qty > 0
        ? [{ bookId, qty }]
        : [];
    });

    const email =
      session.customer_details?.email ?? session.customer_email ?? null;
    const totalCents = session.amount_total ?? 0;
    const db = await getDb();

    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(orders)
        .values({
          stripeSessionId: session.id,
          email,
          totalCents,
          status: "paid",
        })
        .onConflictDoNothing({ target: orders.stripeSessionId })
        .returning({ id: orders.id });

      if (inserted.length === 0) return;
      const orderId = inserted[0].id;

      for (const item of cart) {
        const [book] = await tx
          .select()
          .from(books)
          .where(eq(books.id, item.bookId))
          .limit(1);
        if (!book) continue;

        await tx.insert(orderItems).values({
          orderId,
          bookId: book.id,
          title: book.title,
          priceCents: book.priceCents,
          qty: item.qty,
        });

        await tx
          .update(books)
          .set({ stock: sql`greatest(${books.stock} - ${item.qty}, 0)` })
          .where(eq(books.id, book.id));
      }
    });

    return Response.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handling failed", error);
    return Response.json(
      { error: "Webhook handling failed." },
      { status: 500 },
    );
  }
}
