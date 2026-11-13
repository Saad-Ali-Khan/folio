import {eq} from 'drizzle-orm';
import {setTimeout as delay} from 'node:timers/promises';
import {createDatabase} from '../lib/db';
import {orders,orderItems} from '../lib/db/schema';
import {getStripe} from '../lib/stripe';
import {advanceFulfillment,returnItem} from '../lib/order-service';
import {reconcileCheckouts} from '../lib/checkout-recovery';
async function main(){
 const {db,close}=await createDatabase();
 const [command,arg,extra,qty,reference]=process.argv.slice(2);
 try {
  if(command==='list') {console.table(await db.select().from(orders));return;}
  if(command==='show') {console.table(await db.select().from(orders).where(eq(orders.id,Number(arg))));console.table(await db.select().from(orderItems).where(eq(orderItems.orderId,Number(arg))));return;}
  if(['packed','shipped','delivered'].includes(command)) {await advanceFulfillment(db,Number(arg),command,extra);console.log('Fulfillment updated');return;}
  if(command==='return') {await returnItem(db,Number(arg),Number(extra),Number(qty),reference);console.log('Inspected return recorded');return;}
  if(command==='cancel-order') {
   const [order]=await db.select().from(orders).where(eq(orders.id,Number(arg)));
   if(!order || order.refundedCents!==order.totalCents || !['unfulfilled','packed'].includes(order.fulfillmentStatus))throw new Error('Fully refund an unshipped order in Stripe before cancellation. Inspect and return its stock separately.');
   await db.update(orders).set({fulfillmentStatus:'cancelled'}).where(eq(orders.id,order.id));console.log('Cancelled');return;
  }
  if(command==='reconcile' || command==='cancel-checkout') {
   if (command === 'cancel-checkout' && !arg) throw new Error('Provide the checkout ID to cancel.');
   const unresolved = await reconcileCheckouts(db, getStripe(), command === 'cancel-checkout' ? arg : undefined);
   if (unresolved) process.exitCode = 1;
   return;
  }
  if (command === 'reconcile-loop') {
   if (!process.env.DATABASE_URL?.trim()) throw new Error('The recovery worker requires PostgreSQL via DATABASE_URL.');
   const stripe = getStripe();
   const shutdown = new AbortController();
   const stop = () => shutdown.abort();
   process.once('SIGTERM', stop);
   process.once('SIGINT', stop);
   console.log('Checkout recovery worker started. Checking every five minutes.');
   try {
    while (!shutdown.signal.aborted) {
     try { await reconcileCheckouts(db, stripe); }
     catch (error) { console.error('Checkout recovery pass failed', error); }
     await delay(300_000, undefined, { signal: shutdown.signal }).catch(error => {
      if (!shutdown.signal.aborted) throw error;
     });
    }
   } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
   }
   return;
  }
  throw new Error('Commands: list | show <order> | packed <order> | shipped <order> <tracking> | delivered <order> | return <order> <item> <qty> <unique-reference> | cancel-order <order> | reconcile | reconcile-loop | cancel-checkout <checkout-id>');
 }finally{await close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
