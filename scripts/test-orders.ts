import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {eq} from 'drizzle-orm';
import {readFileSync,readdirSync} from 'node:fs';
import * as schema from '../lib/db/schema';
import type {Database} from '../lib/db';
import {reserveCheckout,releaseCheckout,applyCheckoutSession,recordRefund,advanceFulfillment,returnItem} from '../lib/order-service';
import {shippingFor} from '../lib/store-policy';
import {reconcileCheckouts} from '../lib/checkout-recovery';
async function main(){
 const client=new PGlite();
 try{
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())await client.exec(readFileSync('drizzle/'+f,'utf8'));
  const db=drizzle(client,{schema}) as unknown as Database;
  const [book]=await db.insert(schema.books).values({isbn:'9780141037455',slug:'test',title:'Edition',author:'Author',priceCents:250000,stock:1,status:'published'}).returning();
  const attempts=await Promise.allSettled([reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000'),reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000')]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1,'last copy reserved once');
  const held=attempts.find(a=>a.status==='fulfilled');if(!held || held.status!=='fulfilled')throw Error('No reservation');
  const checkout=held.value;
  await assert.rejects(db.delete(schema.books).where(eq(schema.books.id,book.id)));
  await db.update(schema.books).set({priceCents:900000,title:'Changed title'}).where(eq(schema.books.id,book.id));
  const session={id:'cs_test',metadata:{checkout_id:checkout.id},status:'complete',payment_status:'unpaid',currency:'pkr',amount_subtotal:250000,amount_total:275000,payment_intent:'pi_test',customer_details:{email:'test@example.invalid'},collected_information:{shipping_details:{name:'Test',address:{country:'PK',line1:'Test address'}}}} as unknown as Stripe.Checkout.Session;
  await applyCheckoutSession(db,session);assert.equal((await db.select().from(schema.orders)).length,0,'unpaid not fulfilled');
  const paid={...session,payment_status:'paid'} as Stripe.Checkout.Session;
  await assert.rejects(applyCheckoutSession(db,{...paid,amount_total:1}));
  const partialRefund={payment_intent:'pi_test',amount_refunded:100,refunded:false} as Stripe.Charge;
  await applyCheckoutSession(db,paid,partialRefund);await applyCheckoutSession(db,paid);await releaseCheckout(db,checkout.id);
  const [order]=await db.select().from(schema.orders);const [item]=await db.select().from(schema.orderItems);
  assert.equal(order.currency,'pkr');assert.equal(order.shippingCents,25000);assert.equal(item.priceCents,250000);assert.equal(item.title,'Edition');
  assert.equal(order.status,'partially_refunded');
  assert.equal((await db.select().from(schema.books))[0].stock,0,'payment replay never restores/deducts twice');
  await assert.rejects(advanceFulfillment(db,order.id,'shipped','tracking'));
  await advanceFulfillment(db,order.id,'packed');await assert.rejects(advanceFulfillment(db,order.id,'shipped'));await advanceFulfillment(db,order.id,'shipped','TRACK123');await advanceFulfillment(db,order.id,'delivered');
  const refund={payment_intent:'pi_test',amount_refunded:275000,refunded:true} as Stripe.Charge;
  await recordRefund(db,refund);await recordRefund(db,{...refund,amount_refunded:100,refunded:false});
  assert.equal((await db.select().from(schema.orders))[0].status,'refunded');assert.equal((await db.select().from(schema.books))[0].stock,0,'refund does not restock');
  await returnItem(db,order.id,item.id,1,'return-one');await returnItem(db,order.id,item.id,1,'return-one');
  await assert.rejects(returnItem(db,order.id,item.id,1,'return-two'));assert.equal((await db.select().from(schema.books))[0].stock,1);
  const expired=await reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000');
  const expiry={id:'cs_expired',metadata:{checkout_id:expired.id},status:'expired',payment_status:'unpaid'} as unknown as Stripe.Checkout.Session;
  await applyCheckoutSession(db,expiry);await applyCheckoutSession(db,expiry);assert.equal((await db.select().from(schema.books))[0].stock,1);
  await assert.rejects(applyCheckoutSession(db,{...paid,id:'cs_expired',metadata:{checkout_id:expired.id}}));
  assert.equal(shippingFor(499999),25000);assert.equal(shippingFor(500000),0);
  // Atomic rollback when a later cart line cannot be reserved.
  await assert.rejects(reserveCheckout(db,[{id:book.id,qty:1},{id:99999,qty:1}],'http://localhost:3000'));
  assert.equal((await db.select().from(schema.books))[0].stock,1);
  const request = {id:'same-cart-attempt', clientKey:'test-client'};
  const retried = await Promise.all([
    reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',request),
    reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',request),
  ]);
  assert.equal(retried[0].id, retried[1].id);
  assert.equal((await db.select().from(schema.books))[0].stock,0);
  await assert.rejects(reserveCheckout(db,[{id:book.id,qty:2}],'http://localhost:3000',request), /different cart/);
  await assert.rejects(reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',{...request,clientKey:'other'}), /different cart/);
  await db.update(schema.checkouts).set({createdAt:new Date(0)}).where(eq(schema.checkouts.id, request.id));
  const recovered = {...expiry,id:'cs_recovered',metadata:{checkout_id:request.id}};
  const stripe = {checkout:{sessions:{
    async *list() { yield recovered; },
    async retrieve(id: string) { assert.equal(id,'cs_recovered'); return recovered; },
  }}} as unknown as Stripe;
  assert.equal(await reconcileCheckouts(db,stripe),0);
  assert.equal((await db.select().from(schema.books))[0].stock,1);
  await assert.rejects(reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',request), /ended/);
  for (let index = 0; index < 4; index++) {
    const next = await reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',{...request,id:`attempt-${index}`});
    await releaseCheckout(db,next.id);
  }
  await assert.rejects(reserveCheckout(db,[{id:book.id,qty:1}],'http://localhost:3000',{...request,id:'limit'}), /Too many checkout attempts/);
  assert.equal((await db.select().from(schema.books))[0].stock,1);
  console.log('Passed order tests: competing reservations, rollback, expiry/replays, immutable prices, totals, fulfillment, refund order, inspected return deduplication, shipping threshold');
 }finally{await client.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
