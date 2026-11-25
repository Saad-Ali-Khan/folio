import { randomBytes } from "node:crypto";
import { and, eq, exists, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "./db";
import { books, codRequests, orderItems, orders, type CodDelivery, type Order } from "./db/schema";
import { CheckoutError, matchesCodFulfillment, reserveBookStock, type CodFulfillmentSnapshot } from "./order-service";
import { shippingFor, STORE_CURRENCY } from "./store-policy";

const MAX_STORED_TOTAL = 2_147_483_647; // PostgreSQL integer, in paisa.

export function codWhatsAppNumber() {
  const number = process.env.COD_WHATSAPP_NUMBER?.trim().replace(/^\+/, "") ?? "";
  return /^[1-9]\d{7,14}$/.test(number) ? number : null;
}

export function pakistaniMobile(value: unknown) {
  if (typeof value !== "string" || value.length > 30) return null;
  const match = value.replace(/[\s()-]/g, "").match(/^(?:0|\+?92)(3\d{9})$/);
  return match ? `+92${match[1]}` : null;
}

export async function quoteCodRequest(
  db: Database, items: { id: number; qty: number }[], expectedTotal: number,
) {
  const available = await db.select().from(books)
    .where(and(inArray(books.id, items.map(item => item.id)), eq(books.status, "published")));
  const byId = new Map(available.map(book => [book.id, book]));
  const lines = items.map(({ id, qty }) => {
    const book = byId.get(id);
    if (!book || book.stock < qty || book.priceCents < 1) throw new CheckoutError("A book is unavailable. Review your cart.");
    return { bookId: id, qty, title: book.title, author: book.author, isbn: book.isbn, priceCents: book.priceCents };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.qty * line.priceCents, 0);
  const totalCents = subtotal + shippingFor(subtotal);
  if (totalCents > MAX_STORED_TOTAL) throw new CheckoutError("This order total is too large to process.", 422);
  if (totalCents !== expectedTotal) throw new CheckoutError("The order total changed. Review the updated cart and try again.");
  return { lines, totalCents };
}

export async function createCodRequest(
  db: Database, phone: string, delivery: CodDelivery,
  items: { id: number; qty: number }[], expectedTotal: number,
) {
  const { lines, totalCents } = await quoteCodRequest(db, items, expectedTotal);
  // An approved amendment needs its request row to remain linked to the order.
  await db.delete(codRequests).where(and(
    lt(codRequests.expiresAt, new Date(Date.now() - 86_400_000)),
    or(isNull(codRequests.orderId), exists(db.select({ id: orders.id }).from(orders)
      .where(eq(orders.checkoutId, codRequests.id)))),
  ));
  const [created] = await db.insert(codRequests).values({
    id: randomBytes(6).toString("hex").toUpperCase(), phone, delivery, lines, totalCents,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  }).returning();
  return created;
}

export function pendingCodRequests(db: Database) {
  return db.select().from(codRequests)
    .where(and(isNull(codRequests.orderId), gt(codRequests.expiresAt, new Date())))
    .orderBy(codRequests.expiresAt).limit(100);
}

export async function listCodFulfillmentOrders(db: Database, id?: number) {
  const rows = await db.select({
    order: {
      id: orders.id, phone: orders.phone, delivery: orders.shippingAddress,
      fulfillmentStatus: orders.fulfillmentStatus, trackingNumber: orders.trackingNumber,
      status: orders.status, collectedAt: orders.collectedAt, remittedAt: orders.remittedAt,
      remittanceReference: orders.remittanceReference, remittedCents: orders.remittedCents,
      subtotalCents: orders.subtotalCents, shippingCents: orders.shippingCents, totalCents: orders.totalCents,
    },
    item: { id: orderItems.id, title: orderItems.title, qty: orderItems.qty, returnedQty: orderItems.returnedQty },
  }).from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(eq(orders.paymentMethod, "cod"), id === undefined ? or(
      and(eq(orders.status, "cash_due"), inArray(orders.fulfillmentStatus, ["unfulfilled", "packed", "shipped"])),
      eq(orders.fulfillmentStatus, "returning"),
      and(eq(orders.fulfillmentStatus,"delivered"),inArray(orders.status,["cash_due","paid"]),isNull(orders.remittedAt)),
    ) : eq(orders.id, id)))
    .orderBy(orders.id, orderItems.id);

  type Row = typeof rows[number];
  const grouped = new Map<number, Row["order"] & { items: NonNullable<Row["item"]>[] }>();
  for (const { order, item } of rows) {
    let entry = grouped.get(order.id);
    if (!entry) {
      entry = { ...order, items: [] };
      grouped.set(order.id, entry);
    }
    if (item) entry.items.push(item);
  }
  return Array.from(grouped.values());
}

function sameDelivery(saved: unknown, requested: CodDelivery) {
  const current = saved as Partial<CodDelivery> | null;
  const normalize = (value: string | undefined) => value?.trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(current?.name) === normalize(requested.name) &&
    normalize(current?.address?.line1) === normalize(requested.address.line1) &&
    normalize(current?.address?.line2 ?? "") === normalize(requested.address.line2) &&
    normalize(current?.address?.city) === normalize(requested.address.city) &&
    current?.address?.country === requested.address.country;
}

export async function approveCodRequest(db: Database, id: string, senderPhone: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'cod:' + senderPhone}))`);
    const [request] = await tx.select().from(codRequests).where(eq(codRequests.id, id)).for("update");
    if (!request) throw new CheckoutError("Order request not found.", 404);
    if (request.phone !== senderPhone) throw new CheckoutError("The WhatsApp sender number must match the request.", 400);
    if (request.orderId !== null) {
      const [existing] = await tx.select().from(orders).where(eq(orders.id, request.orderId));
      return existing;
    }
    if (request.expiresAt.getTime() <= Date.now()) throw new CheckoutError("This request expired. Ask the buyer to submit a new one.", 410);
    const { phone, delivery } = request;

    const [open] = await tx.select().from(orders)
      .where(and(eq(orders.phone, phone), eq(orders.paymentMethod, "cod"),
        notInArray(orders.fulfillmentStatus, ["cancelled", "returned", "delivered"])))
      .orderBy(orders.id).limit(1).for("update");
    if (open) {
      if (open.status !== "cash_due" || !["unfulfilled", "packed"].includes(open.fulfillmentStatus)) {
        throw new CheckoutError("The existing COD order has shipped. Wait for delivery or return before approving a new order.");
      }
      if (!sameDelivery(open.shippingAddress, delivery)) {
        throw new CheckoutError("The name and delivery address must match the existing COD order. Ask the buyer to resubmit with the same details.");
      }
    }

    const items = request.lines.map(({ bookId, qty }) => ({ id: bookId, qty }));
    const lines = await reserveBookStock(tx, items, `COD order ${id}`);
    const quotedPrices = new Map(request.lines.map(line => [line.bookId, line.priceCents]));
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.priceCents, 0);
    const quotedTotal = subtotal + shippingFor(subtotal);
    if (quotedTotal !== request.totalCents || lines.some(line => quotedPrices.get(line.bookId) !== line.priceCents)) {
      throw new CheckoutError("Prices changed. Ask the buyer to submit a new request.");
    }
    const combinedSubtotal = (open?.subtotalCents ?? 0) + subtotal;
    const shipping = shippingFor(combinedSubtotal);
    const total = combinedSubtotal + shipping;
    if (total > MAX_STORED_TOTAL) throw new CheckoutError("This order total is too large to process.", 422);

    const totals = { subtotalCents: combinedSubtotal, shippingCents: shipping, totalCents: total };
    const [order] = open
      ? await tx.update(orders).set({ ...totals, fulfillmentStatus: "unfulfilled" })
        .where(eq(orders.id, open.id)).returning()
      : await tx.insert(orders).values({
        ...totals, checkoutId: id, paymentMethod: "cod", status: "cash_due", phone,
        currency: STORE_CURRENCY, shippingAddress: delivery,
      }).returning();
    await tx.insert(orderItems).values(lines.map(line => ({
      orderId: order.id, bookId: line.bookId, title: line.title, priceCents: line.priceCents, qty: line.qty,
    })));
    await tx.update(codRequests).set({ orderId: order.id }).where(eq(codRequests.id, id));
    return order;
  });
}

export async function cancelCodOrder(db: Database, id: number, expected?: CodFulfillmentSnapshot) {
  await db.transaction(async tx => {
    const [order] = await tx.update(orders).set({ status: "void", fulfillmentStatus: "cancelled" })
      .where(and(eq(orders.id, id), eq(orders.paymentMethod, "cod"), eq(orders.status, "cash_due"),
        inArray(orders.fulfillmentStatus, ["unfulfilled", "packed"]),
        expected ? matchesCodFulfillment(expected) : undefined)).returning();
    if (!order) throw new CheckoutError("The order changed or has already shipped. Refresh orders before cancelling.");
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(orderItems.bookId);
    await tx.execute(sql`select set_config('folio.stock_reason', ${'cancelled COD order ' + id}, true)`);
    for (const item of items) {
      await tx.update(books).set({ stock: sql`${books.stock} + ${item.qty}` }).where(eq(books.id, item.bookId));
    }
  });
}

export type CodCashSnapshot = CodFulfillmentSnapshot & Pick<Order,"status"|"totalCents"> & {
  collectedAt:string|null; remittedAt:string|null;
};

export async function recordCodEvent(db: Database, id: number, event: string, amount?: number, reference?: string, expected?:CodCashSnapshot) {
  await db.transaction(async tx => {
    const [order] = await tx.select().from(orders)
      .where(and(eq(orders.id, id), eq(orders.paymentMethod, "cod"))).for("update");
    if (!order) throw new CheckoutError("COD order not found.", 404);

    if(expected && (event==="cod-collected" || event==="cod-remitted")) {
      if(order.fulfillmentStatus!==expected.fulfillmentStatus || order.subtotalCents!==expected.subtotalCents || order.totalCents!==expected.totalCents)
        throw new CheckoutError("The order changed. Refresh orders before recording cash.",409);
      // Identical retries after a lost response are harmless. Different payout details never overwrite a receipt.
      if(event==="cod-collected" && order.collectedAt && order.status==="paid" && amount===order.totalCents)return;
      if(event==="cod-remitted" && order.remittedAt) {
        if(order.remittedCents===amount && order.remittanceReference===reference?.trim())return;
        throw new CheckoutError("A different payout is already recorded. Refresh orders and check the courier statement.",409);
      }
      if(order.status!==expected.status || (order.collectedAt?.toISOString()??null)!==expected.collectedAt ||
        (order.remittedAt?.toISOString()??null)!==expected.remittedAt)
        throw new CheckoutError("The cash record changed. Refresh orders before continuing.",409);
    }

    if (event === "cod-refused" && order.fulfillmentStatus === "shipped" && order.status === "cash_due") {
      await tx.update(orders).set({ fulfillmentStatus: "returning", status: "void" }).where(eq(orders.id, id));
      return;
    }
    if (event === "cod-returned" && order.fulfillmentStatus === "returning") {
      await tx.update(orders).set({ fulfillmentStatus: "returned" }).where(eq(orders.id, id));
      return;
    }
    if (event === "cod-collected" && order.fulfillmentStatus === "delivered" && order.status === "cash_due") {
      if (amount !== order.totalCents) throw new CheckoutError("Collected cash must match the order total. Check the courier record.",400);
      await tx.update(orders).set({ status: "paid", collectedAt: new Date() }).where(eq(orders.id, id));
      return;
    }
    if (event === "cod-remitted" && order.collectedAt && !order.remittedAt) {
      if (amount === undefined || !Number.isSafeInteger(amount) || amount < 0 ||
          amount > order.totalCents || !reference?.trim() || reference.length > 200) {
        throw new CheckoutError("Enter a net payout between zero and the order total, with its courier statement reference.",400);
      }
      await tx.update(orders).set({
        remittedAt: new Date(), remittanceReference: reference.trim(), remittedCents: amount,
      }).where(eq(orders.id, id));
      return;
    }
    throw new CheckoutError("This action is unavailable at the current order stage.",409);
  });
}
