import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "./db";
import { books, checkouts, orders, orderItems, orderReturns, type CheckoutLine } from "./db/schema";
import {shippingFor, STORE_CURRENCY} from "./store-policy";
import { consumeRequestLimit } from "./request-limits";

export class CheckoutError extends Error {
 constructor(message: string, public status = 409) { super(message); }
}

export async function reserveCheckout(
 db: Database,
 items: { id: number; qty: number }[],
 origin: string,
 attempt?: { id: string; clientKey: string },
) {
 const id = attempt?.id ?? randomUUID();
 const sorted = [...items].sort((a, b) => a.id - b.id);
 return db.transaction(async tx => {
  if (attempt) {
   await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'checkout:' + id}))`);
   const [existing] = await tx.select().from(checkouts).where(eq(checkouts.id, id));
   if (existing) {
    const sameCart = existing.lines.length === sorted.length && existing.lines.every(
     (line, index) => line.bookId === sorted[index].id && line.qty === sorted[index].qty,
    );
    if (existing.clientKey !== attempt.clientKey || !sameCart) {
     throw new CheckoutError("This checkout belongs to a different cart or connection. Start a new checkout.", 410);
    }
    if (existing.status === "released") throw new CheckoutError("This checkout ended. Try again to start a new one.", 410);
    return existing;
   }
   if (!await consumeRequestLimit(tx, `checkout:${attempt.clientKey}`, 5, 600)) {
    throw new CheckoutError("Too many checkout attempts. Try again in a few minutes.", 429);
   }
  }
  await tx.execute(sql`select set_config('folio.stock_reason', ${'checkout reservation '+id}, true)`);
  const lines: CheckoutLine[]=[];
  // Stable lock order prevents deadlocks between overlapping carts.
  for (const item of sorted) {
   if (!Number.isInteger(item.qty) || item.qty<1 || item.qty>10) throw new CheckoutError("Invalid quantity", 400);
   const [book]=await tx.update(books).set({stock:sql`${books.stock} - ${item.qty}`})
    .where(and(eq(books.id,item.id),eq(books.status,'published'),gte(books.priceCents,1),gte(books.stock,item.qty))).returning();
   if (!book) throw new CheckoutError("A book is unavailable or has insufficient stock. Refresh your cart.");
   lines.push({bookId:book.id,title:book.title,author:book.author,isbn:book.isbn,priceCents:book.priceCents,qty:item.qty});
  }
  const subtotal=lines.reduce((n,l)=>n+l.priceCents*l.qty,0);
  if (subtotal > 2_000_000_000) throw new CheckoutError("This order exceeds the checkout amount limit.", 400);
  const params: Stripe.Checkout.SessionCreateParams={
   mode:'payment',allowed_payment_method_types:['card'],customer_creation:'always',
   client_reference_id:id,metadata:{checkout_id:id},
   expires_at:Math.floor(Date.now()/1000)+3600,
   shipping_address_collection:{allowed_countries:['PK']},
   shipping_options:[{shipping_rate_data:{type:'fixed_amount',display_name:'Pakistan delivery',fixed_amount:{amount:shippingFor(subtotal),currency:STORE_CURRENCY}}}],
   line_items:lines.map(l=>({quantity:l.qty,price_data:{currency:STORE_CURRENCY,unit_amount:l.priceCents,product_data:{name:l.title,description:l.author,metadata:{book_id:String(l.bookId)}}}})),
   success_url:`${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/cart`,
  };
  const [checkout]=await tx.insert(checkouts).values({id,clientKey:attempt?.clientKey,lines,params}).returning();
  return checkout;
 });
}

export async function releaseCheckout(db:Database,id:string) {
 return db.transaction(async tx=>{
  const [held]=await tx.update(checkouts).set({status:'released'}).where(and(eq(checkouts.id,id),eq(checkouts.status,'held'))).returning();
  if(!held)return;
  await tx.execute(sql`select set_config('folio.stock_reason', ${'released reservation '+id}, true)`);
  for(const line of held.lines)await tx.update(books).set({stock:sql`${books.stock} + ${line.qty}`}).where(eq(books.id,line.bookId));
 });
}

export async function applyCheckoutSession(db:Database,session:Stripe.Checkout.Session,charge?:Stripe.Charge) {
 const id=session.metadata?.checkout_id;
 if(!id)throw new Error(`Unlinked Stripe session ${session.id}; manual reconciliation required`);
 await db.transaction(async tx=>{
  const [checkout]=await tx.select().from(checkouts).where(eq(checkouts.id,id)).for('update');
  if(!checkout)throw new Error('Unknown checkout');
  if(checkout.stripeSessionId && checkout.stripeSessionId!==session.id)throw new Error('Session mismatch');
  await tx.update(checkouts).set({stripeSessionId:session.id}).where(eq(checkouts.id,id));
  if(session.payment_status==='paid'){
   if(checkout.status==='paid'){
    if (charge?.amount_refunded) await recordRefund(tx, charge);
    return;
   }
   if(checkout.status!=='held')throw new Error('Payment received after reservation release; manual review required');
   const subtotal=checkout.lines.reduce((n,l)=>n+l.priceCents*l.qty,0);
   const shipping=checkout.params.shipping_options?.[0]?.shipping_rate_data?.fixed_amount?.amount ?? 0;
   const address=session.collected_information?.shipping_details;
   if(session.currency!==STORE_CURRENCY || session.amount_subtotal!==subtotal || session.amount_total!==subtotal+shipping || !address || address.address?.country!=='PK') throw new Error('Payment totals or shipping address mismatch');
   const [order]=await tx.insert(orders).values({checkoutId:id,stripeSessionId:session.id,email:session.customer_details?.email ?? null,totalCents:session.amount_total,subtotalCents:subtotal,shippingCents:shipping,currency:STORE_CURRENCY,status:'paid',shippingAddress:address,paymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id}).returning();
   await tx.insert(orderItems).values(checkout.lines.map(l=>({orderId:order.id,bookId:l.bookId,title:l.title,priceCents:l.priceCents,qty:l.qty})));
   if (charge?.amount_refunded) await recordRefund(tx, charge);
   await tx.update(checkouts).set({status:'paid'}).where(eq(checkouts.id,id));
   return;
  }
  if(session.status==='expired' && checkout.status==='held'){
   await tx.execute(sql`select set_config('folio.stock_reason', ${'expired reservation '+id}, true)`);
   for(const line of checkout.lines)await tx.update(books).set({stock:sql`${books.stock} + ${line.qty}`}).where(eq(books.id,line.bookId));
   await tx.update(checkouts).set({status:'released'}).where(eq(checkouts.id,id));
  }
 });
}

export async function recordRefund(db:Pick<Database,"update">,charge:Stripe.Charge){
 const intent=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
 if(!intent)return;
 // Refunds never restock automatically: physical returns require inspection.
 await db.update(orders).set({refundedCents:charge.amount_refunded,status:charge.refunded?'refunded':'partially_refunded'})
 .where(and(eq(orders.paymentIntentId,intent),gte(sql`${charge.amount_refunded}`,orders.refundedCents)));
}

export async function advanceFulfillment(db:Database,id:number,next:string,tracking?:string){
 const allowed:Record<string,string>={packed:'unfulfilled',shipped:'packed',delivered:'shipped'};
 if(!allowed[next] || (next==='shipped'&&!tracking?.trim()))throw new Error('Invalid transition or missing tracking number');
 const [order]=await db.update(orders).set({fulfillmentStatus:next,...(next==='shipped'?{trackingNumber:tracking!.trim()}:{})})
 .where(and(eq(orders.id,id),inArray(orders.status,['paid','partially_refunded']),eq(orders.fulfillmentStatus,allowed[next]))).returning();
 if(!order)throw new Error('Order is unpaid, fully refunded, missing, or at an incompatible fulfillment stage');
 return order;
}

export async function returnItem(db:Database,orderId:number,itemId:number,qty:number,reference:string){
 if(!reference?.trim() || !Number.isInteger(qty)||qty<1)throw new Error('Invalid return quantity');
 await db.transaction(async tx=>{
  const [order]=await tx.select().from(orders).where(eq(orders.id,orderId)).for('update');
  if(!order)throw new Error('Order not found');
  const [claim]=await tx.insert(orderReturns).values({reference,orderItemId:itemId,qty}).onConflictDoNothing().returning();
  if(!claim){
   const [prior]=await tx.select().from(orderReturns).where(eq(orderReturns.reference,reference));
   if(prior.orderItemId!==itemId || prior.qty!==qty)throw new Error('Return reference reused with different details');
   return;
  }
  const [item]=await tx.update(orderItems).set({returnedQty:sql`${orderItems.returnedQty}+${qty}`})
   .where(and(eq(orderItems.id,itemId),eq(orderItems.orderId,orderId),gte(sql`${orderItems.qty}-${orderItems.returnedQty}`,qty))).returning();
  if(!item)throw new Error('Return exceeds outstanding quantity');
  await tx.execute(sql`select set_config('folio.stock_reason', ${'inspected return order '+orderId}, true)`);
  await tx.update(books).set({stock:sql`${books.stock}+${qty}`}).where(eq(books.id,item.bookId));
 });
}
