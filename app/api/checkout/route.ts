import type Stripe from "stripe";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

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
    parsed.push({ id, qty });
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

  const db = await getDb();
  const rows = await db
    .select()
    .from(books)
    .where(inArray(books.id, items.map((item) => item.id)));
  const booksById = new Map(rows.map((book) => [book.id, book]));

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

  for (const item of items) {
    const book = booksById.get(item.id);
    if (!book) {
      return Response.json(
        { error: "One of the books in your cart is no longer available." },
        { status: 409 },
      );
    }
    if (book.stock < item.qty) {
      return Response.json(
        {
          error:
            book.stock === 0
              ? `“${book.title}” is sold out.`
              : `Only ${book.stock} copies of “${book.title}” left in stock.`,
        },
        { status: 409 },
      );
    }

    lineItems.push({
      quantity: item.qty,
      price_data: {
        currency: "usd",
        unit_amount: book.priceCents,
        product_data: {
          name: book.title,
          description: book.author,
          images: book.coverUrl ? [book.coverUrl] : undefined,
          metadata: { book_id: String(book.id) },
        },
      },
    });
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin;

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_creation: "always",
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart`,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    return Response.json({ url: session.url });
  } catch (error) {
    console.error("Failed to create Stripe checkout session", error);
    return Response.json(
      { error: "Checkout is unavailable right now. Please try again." },
      { status: 502 },
    );
  }
}
