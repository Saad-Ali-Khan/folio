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
import {approveCodRequest, cancelCodOrder, createCodRequest, pakistaniMobile, recordCodEvent} from '../lib/cod-order';
import {POST as checkoutRequest} from '../app/api/checkout/route';
import {POST as testCheckoutRequest} from '../app/api/admin/whatsapp/checkout/route';
import {POST as requestStatus} from '../app/api/checkout/status/route';
import {GET as listRequests, POST as approveRequest} from '../app/api/admin/cod/route';
import {GET as listFulfillment, POST as updateFulfillment} from '../app/api/admin/cod/orders/route';
import {ADMIN_COOKIE, issueSession} from '../lib/admin-auth';
import {codRequestStatus, codStatusToken} from '../lib/cod-request-status';
import {parseCart, resizeCartLine, resolveCartRequest} from '../lib/cart-state';
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
  const renamedTitle = 'Changed title';
  await db.update(schema.books).set({priceCents:900000,title:renamedTitle}).where(eq(schema.books.id,book.id));
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
  const phone = pakistaniMobile('0300-1234567')!;
  assert.equal(phone, '+923001234567');
  assert.equal(pakistaniMobile('+15555550123'), null);
  const delivery = { name: 'Test Reader', address: { line1: '1 Test Street', line2: '', city: 'Lahore', country: 'PK' as const } };
  const codItems = [{ id: book.id, qty: 1 }];
  const stock = async () => (await db.select().from(schema.books))[0].stock;
  await db.update(schema.books).set({ priceCents: 800000000, stock: 3 }).where(eq(schema.books.id, book.id));
  await assert.rejects(createCodRequest(db, phone, delivery, [{id:book.id, qty:3}], 2400000000), /too large to process/);
  await db.update(schema.books).set({ priceCents: 250000, stock: 3 }).where(eq(schema.books.id, book.id));
  const [first, second, third, fourth, fifth] = await Promise.all(
    Array.from({length: 5}, () => createCodRequest(db, phone, delivery, codItems, 275000)),
  );
  await assert.rejects(approveCodRequest(db, first.id, '+923111234567'), /sender number/);
  await db.update(schema.books).set({ priceCents: 250001 }).where(eq(schema.books.id, book.id));
  await assert.rejects(approveCodRequest(db, first.id, phone), /Prices changed/);
  assert.equal(await stock(), 3);
  await db.update(schema.books).set({ priceCents: 250000 }).where(eq(schema.books.id, book.id));
  const [cod, replay] = await Promise.all([
    approveCodRequest(db, first.id, phone),
    approveCodRequest(db, first.id, phone),
  ]);
  assert.equal(cod.id, replay.id);
  assert.equal(cod.status, 'cash_due');
  assert.equal(await stock(), 2);
  const wrongAddress = await createCodRequest(db, phone, {
    ...delivery, address: { ...delivery.address, line1: '2 Different Street' },
  }, codItems, 275000);
  await assert.rejects(approveCodRequest(db, wrongAddress.id, phone), /address must match/);
  assert.equal(await stock(), 2);
  await db.update(schema.codRequests).set({ expiresAt: new Date(0) }).where(eq(schema.codRequests.id, wrongAddress.id));
  await advanceFulfillment(db, cod.id, 'packed');
  const [amended, amendedReplay] = await Promise.all([
    approveCodRequest(db, second.id, phone), approveCodRequest(db, second.id, phone),
  ]);
  assert.equal(amended.id, cod.id);
  assert.deepEqual(amendedReplay, amended);
  assert.equal(amended.fulfillmentStatus, 'unfulfilled');
  assert.equal(amended.subtotalCents, 500000);
  assert.equal(amended.shippingCents, 0);
  assert.equal(amended.totalCents, 500000);
  assert.equal(await stock(), 1);
  assert.equal(await codRequestStatus(db, second.id), 'approved');
  await db.update(schema.codRequests).set({ expiresAt: new Date(0) }).where(eq(schema.codRequests.id, second.id));
  const cleanupTrigger = await createCodRequest(db, phone, delivery, codItems, 275000);
  assert.equal(await codRequestStatus(db, wrongAddress.id), 'closed');
  assert.equal(await codRequestStatus(db, second.id), 'approved');
  assert.equal((await approveCodRequest(db, second.id, phone)).id, cod.id);
  await db.update(schema.codRequests).set({ expiresAt: new Date(0) }).where(eq(schema.codRequests.id, cleanupTrigger.id));
  const aboveOldCap = await approveCodRequest(db, third.id, phone);
  assert.equal(aboveOldCap.id, cod.id);
  assert.equal(aboveOldCap.totalCents, 750000);
  assert.equal(await stock(), 0);
  await cancelCodOrder(db, cod.id);
  await assert.rejects(cancelCodOrder(db, cod.id));
  assert.equal(await stock(), 3, 'Cancellation restores original and added copies');
  assert.equal(await codRequestStatus(db, second.id), 'closed');
  const refused = await approveCodRequest(db, fourth.id, phone);
  await advanceFulfillment(db, refused.id, 'packed');
  await advanceFulfillment(db, refused.id, 'shipped', 'TEST-1');
  await assert.rejects(approveCodRequest(db, fifth.id, phone), /has shipped/);
  await recordCodEvent(db, refused.id, 'cod-refused');
  const [returnedItem] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, refused.id));
  await assert.rejects(returnItem(db, refused.id, returnedItem.id, 1, 'cod-return'), /Inspect/);
  await recordCodEvent(db, refused.id, 'cod-returned');
  await returnItem(db, refused.id, returnedItem.id, 1, 'cod-return');
  assert.equal(await stock(), 3);
  const delivered = await approveCodRequest(db, fifth.id, phone);
  await advanceFulfillment(db, delivered.id, 'packed');
  await advanceFulfillment(db, delivered.id, 'shipped', 'TEST-2');
  await advanceFulfillment(db, delivered.id, 'delivered');
  await assert.rejects(recordCodEvent(db, delivered.id, 'cod-remitted', 270000, 'statement'));
  await assert.rejects(recordCodEvent(db, delivered.id, 'cod-collected', 1), /must match/);
  await recordCodEvent(db, delivered.id, 'cod-collected', 275000);
  await recordCodEvent(db, delivered.id, 'cod-remitted', 270000, 'statement');
  const [settled] = await db.select().from(schema.orders).where(eq(schema.orders.id, delivered.id));
  assert.equal(settled.status, 'paid');
  assert.equal(settled.remittedCents, 270000);
  const dbGlobal = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
  dbGlobal.folioDb = Promise.resolve(db);
  process.env.COD_WHATSAPP_NUMBER = '+923001234560';
  process.env.ADMIN_PIN = 'test-admin-pin';
  process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';
  try {
    await db.update(schema.books).set({ stock: 3 }).where(eq(schema.books.id, book.id));
    const request = (fields: Record<string, unknown>, cookie?: string, test = false) => (test ? testCheckoutRequest : checkoutRequest)(new Request(
      `http://localhost:3000${test ? '/api/admin/whatsapp/checkout' : '/api/checkout'}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ phone, name: delivery.name, line1: delivery.address.line1,
        city: delivery.address.city, items: codItems, totalCents: 275000, ...fields }),
    }));
    const originalFetch = globalThis.fetch;
    process.env.WHATSAPP_TEST_ACCESS_TOKEN = 'fake-token';
    process.env.WHATSAPP_TEST_PHONE_NUMBER_ID = '123456789';
    process.env.WHATSAPP_TEST_RECIPIENT = phone;
    const cookie = ADMIN_COOKIE + '=' + issueSession();
    let sends = 0;
    globalThis.fetch = async (url, init) => {
      sends += 1;
      assert.match(String(url), /^https:\/\/graph\.facebook\.com\//);
      assert.equal(JSON.parse(String(init?.body)).to, phone.slice(1));
      return Response.json({ messages: [{ id: 'wamid.test' }] });
    };
    try {
      const before = await db.select().from(schema.codRequests);
      assert.equal((await request({}, undefined, true)).status, 401);
      assert.equal((await request({ phone: '+923111234567' }, cookie, true)).status, 400);
      assert.equal((await request({ totalCents: 1 }, cookie, true)).status, 409);
      const results = await Promise.all(Array.from({ length: 2 }, () => request({}, cookie, true)));
      assert.deepEqual(results.map(response => response.status).sort(), [200, 429]);
      assert.deepEqual(await results.find(response => response.ok)!.json(), { accepted: true, whatsappTest: true });
      assert.equal(sends, 1);
      assert.deepEqual(await db.select().from(schema.codRequests), before);
      assert.equal(await stock(), 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal((await request({ city: '' })).status, 400);
    const largeOrder = await request({ city: 'Karachi', items: [{id:book.id, qty:3}], totalCents:750000 });
    assert.equal(largeOrder.status, 200);
    const largeQuote = await largeOrder.json();
    assert.equal(largeQuote.totalCents, 750000);
    await db.update(schema.codRequests).set({ expiresAt: new Date(0) }).where(eq(schema.codRequests.id, largeQuote.reference));
    await db.update(schema.books).set({ stock: 2 }).where(eq(schema.books.id, book.id));
    const submitted = await request({ city: 'Quetta' });
    assert.equal(submitted.status, 200);
    const { reference, whatsappUrl, statusToken } = await submitted.json();
    const url = new URL(whatsappUrl);
    assert.equal(url.hostname, 'wa.me');
    assert.equal(url.pathname, '/923001234560');
    assert.match(url.searchParams.get('text') ?? '', new RegExp(reference));
    assert.match(statusToken, /^[a-f0-9]{64}$/);
    assert.ok(!(url.searchParams.get('text') ?? '').includes(statusToken));
    assert.equal(await stock(), 2);
    const readStatus = (ref = reference, token = statusToken, origin = 'http://localhost:3000') =>
      requestStatus(new Request('http://localhost:3000/api/checkout/status', {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ reference: ref, token }),
      }));
    assert.equal((await readStatus(reference, '0'.repeat(64))).status, 404);
    assert.equal((await readStatus(first.id)).status, 404);
    assert.equal((await readStatus(reference, statusToken, 'https://example.com')).status, 403);
    assert.deepEqual(await (await readStatus()).json(), {status:'pending'});
    assert.deepEqual(await (await readStatus(first.id, codStatusToken(first.id))).json(), {status:'closed'});
    const adminUrl = 'http://localhost:3000/api/admin/cod';
    assert.equal((await listRequests(new Request(adminUrl))).status, 401);
    const adminHeaders = { cookie: ADMIN_COOKIE + '=' + issueSession(), origin: 'http://localhost:3000',
      'content-type': 'application/json' };
    const queue = await listRequests(new Request(adminUrl, { headers: adminHeaders }));
    const queuedRequests = (await queue.json()).requests;
    assert.deepEqual(queuedRequests.map((row: {id: string}) => row.id), [reference]);
    assert.equal(queuedRequests[0].delivery.address.city, 'Quetta');
    assert.equal(queuedRequests[0].delivery.address.country, 'PK');
    const approve = (sender: string, headers = adminHeaders) => approveRequest(new Request(adminUrl, {
      method: 'POST', headers, body: JSON.stringify({ reference, sender }),
    }));
    assert.equal((await approve(phone, { ...adminHeaders, cookie: '' })).status, 401);
    assert.equal((await approve('+923111234567')).status, 400);
    assert.equal(await stock(), 2);
    const placed = await approve(phone);
    assert.equal(placed.status, 200);
    const placedOrder = await placed.json();
    assert.deepEqual(await (await approve(phone)).json(), placedOrder);
    assert.equal(await stock(), 1);
    const approvedStatus = await readStatus();
    assert.equal(approvedStatus.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await approvedStatus.json(), {status:'approved'});

    const legacyCart = parseCart(JSON.stringify([{id:book.id, slug:book.slug, title:book.title,
      author:book.author, priceCents:book.priceCents, coverUrl:null, qty:1}]));
    const original = legacyCart.items[0];
    const withExtraCopy = resizeCartLine(original, 2);
    const requestToResolve = {reference, token:statusToken, copyIds:original.copyIds};
    const restored = parseCart(JSON.stringify({items:[withExtraCopy], requests:[requestToResolve]}));
    const resolved = resolveCartRequest(restored, reference, true);
    assert.deepEqual(resolved.items[0].copyIds, withExtraCopy.copyIds.slice(1));
    assert.equal(resolved.items[0].qty, 1);
    assert.equal(resolveCartRequest(resolved, reference, true), resolved);
    assert.deepEqual(resolveCartRequest(restored, reference, false).items, restored.items);
    const replacement = resizeCartLine({...original, copyIds:[]}, 1);
    assert.deepEqual(resolveCartRequest({items:[replacement], requests:[requestToResolve]}, reference, true).items,
      [replacement]);

    const fulfillmentUrl = `${adminUrl}/orders`;
    const loadOrders = (id?: number) => listFulfillment(new Request(
      id === undefined ? fulfillmentUrl : `${fulfillmentUrl}?id=${id}`, { headers: adminHeaders },
    ));
    const updateOrder = (fields: Record<string, unknown>, headers = adminHeaders) =>
      updateFulfillment(new Request(fulfillmentUrl, { method: 'POST', headers, body: JSON.stringify({
        id: placedOrder.orderId, subtotalCents: 250000, fulfillmentStatus: 'unfulfilled', ...fields,
      }) }));
    assert.equal((await listFulfillment(new Request(fulfillmentUrl))).status, 401);
    const fulfillmentResponse = await loadOrders();
    assert.equal(fulfillmentResponse.headers.get('cache-control'), 'no-store');
    const fulfillmentQueue = (await fulfillmentResponse.json()).orders;
    assert.equal(fulfillmentQueue.length, 1);
    assert.equal(fulfillmentQueue[0].id, placedOrder.orderId);
    assert.equal(fulfillmentQueue[0].delivery.address.city, 'Quetta');
    assert.deepEqual(fulfillmentQueue[0].items.map(({title, qty}: {title:string; qty:number}) => ({title, qty})),
      [{ title: renamedTitle, qty: 1 }]);
    assert.equal((await updateOrder({action:'packed'}, {...adminHeaders, cookie:''})).status, 401);
    assert.equal((await updateOrder({action:'packed'}, {...adminHeaders, origin:'https://example.com'})).status, 403);
    assert.equal((await updateOrder({action:'packed', subtotalCents:249999})).status, 409);
    assert.equal((await updateOrder({action:'shipped', tracking:'TRACK'})).status, 409);
    assert.equal((await updateOrder({action:'cancelled'})).status, 200);
    assert.equal(await stock(), 2);
    assert.equal((await updateOrder({action:'cancelled'})).status, 409);
    assert.equal(await stock(), 2);

    const nextRequest = await createCodRequest(db, phone, delivery, codItems, 275000);
    const nextOrder = await approveCodRequest(db, nextRequest.id, phone);
    assert.equal((await updateOrder({id:nextOrder.id, action:'packed'})).status, 200);
    assert.equal((await updateOrder({id:nextOrder.id, action:'shipped', fulfillmentStatus:'packed', tracking:' '})).status, 400);
    assert.equal((await updateOrder({id:nextOrder.id, action:'shipped', fulfillmentStatus:'packed', tracking:' TRACK-2 '})).status, 200);
    assert.equal((await updateOrder({id:nextOrder.id, action:'cancelled', fulfillmentStatus:'shipped'})).status, 409);
    assert.equal((await updateOrder({id:nextOrder.id, action:'delivered', fulfillmentStatus:'shipped'})).status, 200);
    assert.deepEqual((await (await loadOrders()).json()).orders, []);
    const [updatedOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, nextOrder.id));
    assert.equal(updatedOrder.trackingNumber, 'TRACK-2');
    assert.equal(updatedOrder.status, 'cash_due');
    assert.equal(await stock(), 1);

    await db.update(schema.books).set({ stock: 2 }).where(eq(schema.books.id, book.id));
    const returnRequest = await createCodRequest(db, phone, delivery, [{ id: book.id, qty: 2 }], 500000);
    const returnOrder = await approveCodRequest(db, returnRequest.id, phone);
    const returnAction = (fields: Record<string, unknown>) => updateOrder({ id: returnOrder.id, subtotalCents: 500000, ...fields });
    assert.equal((await returnAction({action:'packed'})).status, 200);
    assert.equal((await returnAction({action:'shipped', fulfillmentStatus:'packed', tracking:'RETURN-1'})).status, 200);
    assert.equal((await returnAction({action:'refused', fulfillmentStatus:'shipped'})).status, 200);
    const {orders: [returning]} = await (await loadOrders()).json();
    assert.equal(returning.fulfillmentStatus, 'returning');
    const restock = (fulfillmentStatus: string, qty: number, returnedQty: number, itemId = returning.items[0].id) =>
      returnAction({action:'restock', fulfillmentStatus, itemId, qty, returnedQty});
    assert.equal((await restock('returning', 1, 0)).status, 409);
    assert.equal(await stock(), 0);
    assert.equal((await returnAction({action:'returned', fulfillmentStatus:'returning'})).status, 200);
    assert.equal(await stock(), 0, 'Receiving a parcel does not restock it');
    assert.deepEqual((await (await loadOrders()).json()).orders, []);
    const {orders: [received]} = await (await loadOrders(returnOrder.id)).json();
    assert.equal(received.fulfillmentStatus, 'returned');
    assert.equal((await restock('returned', 1, 0, returnedItem.id)).status, 404);
    assert.equal((await restock('returned', 1, 0)).status, 200);
    assert.equal((await restock('returned', 1, 0)).status, 200);
    assert.equal((await restock('returned', 2, 1)).status, 409);
    assert.equal(await stock(), 1, 'Only the inspected copy is restocked');
    const {orders: [restocked]} = await (await loadOrders(returnOrder.id)).json();
    assert.equal(restocked.items[0].returnedQty, 1);
  } finally {
    delete dbGlobal.folioDb;
  }
  console.log('Passed manual WhatsApp COD approval, idempotency, cancellation, inspected returns, and courier settlement');
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
