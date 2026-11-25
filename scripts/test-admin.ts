import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {eq} from 'drizzle-orm';
import {readFileSync,readdirSync} from 'node:fs';
import * as schema from '../lib/db/schema';
import type {Database} from '../lib/db';
import {deleteAdminBook,updateAdminBook,AdminBookError} from '../lib/admin-books';
import {issueSession,validSession,validAdminPin,sameOrigin,requestIsAdmin} from '../lib/admin-auth';
import {applyMigrations} from '../lib/db/migrations';
import {consumeRequestLimit} from '../lib/request-limits';
import {queueStockChoice,resolveStockChoice} from '../lib/discord-stock-choice';
import {POST as discordInventory} from '../app/api/discord/inventory/route';
import {GET as getStockHistory} from '../app/api/admin/books/stock/route';
async function main(){
 process.env.ADMIN_PIN='test-only-pin';process.env.ADMIN_SESSION_SECRET='test-only-session-secret';
 const token=issueSession();assert(validSession(token));assert(!validSession(token+'x'));assert(!validSession(token,Date.now()+9*3600000));assert(validAdminPin('test-only-pin'));assert(!validAdminPin('incorrect'));
 assert(sameOrigin(new Request('http://localhost:3000/api/admin/books',{headers:{origin:'http://localhost:3000'}})));
 assert(!sameOrigin(new Request('http://localhost:3000/api/admin/books',{headers:{origin:'https://other.invalid'}})));
 const loopbackRequest = (origin: string) => new Request('http://localhost:3000/api/admin/books', {
  headers: {host:'127.0.0.1:3000', origin},
 });
 assert(sameOrigin(loopbackRequest('http://127.0.0.1:3000')));
 assert(!sameOrigin(loopbackRequest('http://localhost:3000')));
 assert(!requestIsAdmin(new Request('http://localhost:3000/api/admin/books')));
 assert(requestIsAdmin(new Request('http://localhost:3000/api/admin/books',{headers:{cookie:`folio-admin=${token}`}})));
 const client=new PGlite();try{
 const db=drizzle(client,{schema}) as unknown as Database;
 const migrations = readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()
  .map(name => ({name, contents: readFileSync('drizzle/' + name, 'utf8')}));
 assert.equal((await applyMigrations(db, migrations)).length, migrations.length);
 assert.deepEqual(await applyMigrations(db, migrations), []);
 await assert.rejects(applyMigrations(db, [{name:'broken-test', contents:'create table rollback_probe(id integer);--> statement-breakpoint\nselect unknown_test_function()'}]));
 const rollback = await client.query<{ exists: boolean }>("select to_regclass('rollback_probe') is not null as exists");
 assert.equal(rollback.rows[0].exists, false);
 assert.equal(await consumeRequestLimit(db, 'admin:test', 1, 60), true);
 assert.equal(await consumeRequestLimit(db, 'admin:test', 1, 60), false);
 await db.update(schema.requestLimits).set({expiresAt: new Date(0)}).where(eq(schema.requestLimits.key, 'admin:test'));
 assert.equal(await consumeRequestLimit(db, 'admin:test', 1, 60), true);
 const [book]=await db.insert(schema.books).values({isbn:'9780141037455',slug:'admin-test',title:'Title',author:'Author',description:'Description',priceCents:0,stock:4}).returning();
 const input={...book,price:'0.00',expected:book};
 await assert.rejects(updateAdminBook(db,{...input,status:'published'}));
 await assert.rejects(updateAdminBook(db,{...input,price:'1500.999'}));
 await assert.rejects(updateAdminBook(db,{...input,stock:-1}));
 await assert.rejects(updateAdminBook(db,{...input,stock:7}), /stock adjustment reason/);
 await assert.rejects(updateAdminBook(db,{...input,stock:7,stockReason:'   '}), /stock adjustment reason/);
 const updated=await updateAdminBook(db,{...input,price:'1500',stock:7,status:'published',stockReason:'  Counted copies  '});
 assert.equal(updated.priceCents,150000);assert.equal(updated.status,'published');
 await assert.rejects(updateAdminBook(db,{...input,title:'Stale edit'}),e=>e instanceof AdminBookError&&e.status===409);
 const movements=await db.select().from(schema.stockMovements);assert.equal(movements.at(-1)?.reason,'admin inventory edit: Counted copies');assert.equal(movements.at(-1)?.delta,3);
 const draft=await updateAdminBook(db,{...updated,price:'1500',status:'draft',expected:updated});assert.equal(draft.status,'draft');
 assert.equal((await db.select().from(schema.stockMovements)).length, movements.length);
 await assert.rejects(deleteAdminBook(db, {expected: book}), /changed or was already deleted/);
 await db.insert(schema.checkouts).values({
  id: 'test-hold', lines: [{bookId: draft.id, title: draft.title, author: draft.author, isbn: draft.isbn, priceCents: draft.priceCents, qty: 1}], params: {},
 });
 await assert.rejects(deleteAdminBook(db, {expected: draft}), /active checkout reservation/);
 await db.update(schema.checkouts).set({status: 'released'}).where(eq(schema.checkouts.id, 'test-hold'));
 const [order] = await db.insert(schema.orders).values({stripeSessionId: 'test-session', totalCents: draft.priceCents}).returning();
 await db.insert(schema.orderItems).values({orderId: order.id, bookId: draft.id, title: draft.title, priceCents: draft.priceCents, qty: 1});
 await assert.rejects(deleteAdminBook(db, {expected: draft}), /appears in an order/);
 const [unused] = await db.insert(schema.books).values({isbn:'test-unused',slug:'unused',title:'Unused',author:'Author',priceCents:0}).returning();
 await queueStockChoice(db, {messageId: 'original-request', userId: 'operator', channelId: 'inventory'}, {verb:'ADD', qty:2}, [unused]);
 const [choice] = await db.select().from(schema.discordStockChoices);
 assert.match(await resolveStockChoice(db, choice.id, 'other-user', 'inventory', '1'), /not found/);
 assert.match(await resolveStockChoice(db, choice.id, 'operator', 'other-channel', '1'), /not found/);
 await resolveStockChoice(db, choice.id, 'operator', 'inventory', '1');
 assert.match(await resolveStockChoice(db, choice.id, 'operator', 'inventory', '1'), /already handled/);
 const [confirmed] = await db.select().from(schema.books).where(eq(schema.books.id, unused.id));
 assert.equal(confirmed.stock, 2);
 assert.equal((await deleteAdminBook(db, {expected: confirmed})).id, unused.id);
 assert.deepEqual((await db.select({id: schema.books.id}).from(schema.books)).map(row => row.id), [draft.id]);
 const dbGlobal = globalThis as typeof globalThis & { folioDb?: Promise<Database> };
 dbGlobal.folioDb = Promise.resolve(db);
 process.env.DISCORD_CHANNEL_ID = 'inventory';
 process.env.INVENTORY_DISCORD_PIN = 'test-pin';
 process.env.INVENTORY_DISCORD_SECRET = 'test-discord-secret';
 try {
  const [paperback, hardback] = await db.insert(schema.books).values([
   {isbn:'9780441172719', slug:'dune', title:'Dune', author:'Frank Herbert', priceCents:100000, stock:3},
   {isbn:'9780441013593', slug:'dune-hardback', title:'Dune', author:'Frank Herbert', priceCents:120000, stock:4},
  ]).returning();
  const send = async (messageId: string, command: string) => {
   const response = await discordInventory(new Request('http://localhost:3000/api/discord/inventory', {
    method:'POST', headers:{'x-inventory-secret':'test-discord-secret', 'content-type':'application/json'},
    body:JSON.stringify({messageId, userId:'operator', channelId:'inventory', text:`test-pin ${command}`}),
   }));
   assert.equal(response.status, 200);
   return (await response.json()).reply as string;
  };
  const stock = async (id: number) => (await db.select().from(schema.books).where(eq(schema.books.id, id)))[0].stock;
  const historyUrl = `http://localhost:3000/api/admin/books/stock?bookId=${draft.id}`;
  const sessionHeaders = {cookie:`folio-admin=${token}`};
  assert.equal((await getStockHistory(new Request(historyUrl))).status, 401);
  const firstHistory = await getStockHistory(new Request(historyUrl, {headers:sessionHeaders}));
  assert.equal(firstHistory.headers.get('cache-control'), 'no-store');
  const history = await firstHistory.json();
  assert.deepEqual(history.movements.map((entry: {reason: string}) => entry.reason), ['admin inventory edit: Counted copies', 'received']);
  assert.deepEqual([history.movements[0].before, history.movements[0].after], [4, 7]);
  assert.equal(history.nextBefore, null);
  await db.insert(schema.stockMovements).values(Array.from({length:26}, (_, position) => ({
   bookId:draft.id, before:position, after:position+1, delta:1, reason:'Pagination fixture',
  })));
  const page = await (await getStockHistory(new Request(historyUrl, {headers:sessionHeaders}))).json();
  assert.equal(page.movements.length, 25);
  const older = await (await getStockHistory(new Request(`${historyUrl}&before=${page.nextBefore}`, {headers:sessionHeaders}))).json();
  assert.equal(older.movements.length, 3);
  assert.ok(older.movements[0].id < page.movements.at(-1).id);
  assert.equal(older.nextBefore, null);
  const prompt = await send('duplicate-title', 'SOLD Dune 1');
  assert.match(prompt, /Which book did you mean/);
  assert.match(prompt, /9780441172719/);
  assert.match(prompt, /9780441013593/);
  assert.equal(await stock(paperback.id), 3);
  assert.equal(await stock(hardback.id), 4);
  const confirmation = prompt.match(/CONFIRM ([a-f0-9]{10})/);
  assert.ok(confirmation);
  await send('choose-hardback', `CONFIRM ${confirmation[1]} 2`);
  assert.equal(await stock(paperback.id), 3);
  assert.equal(await stock(hardback.id), 3);
  assert.match(await send('explicit-slug','ADD slug:dune 1'), /OK dune: stock 4/);
  assert.match(await send('plain-slug','ADD dune-hardback 1'), /OK dune-hardback: stock 4/);
  assert.match(await send('exact-isbn','SET 978-0-441-17271-9 2'), /OK dune: stock 2/);
  assert.match(await send('bad-slug','ADD slug:unknown 1'), /No book uses that slug/);
  assert.match(await send('ambiguous-price','PRICE Dune 99'), /Multiple listings match/);
  assert.match(await send('price-limit','PRICE slug:dune 1000000.00'), /Price updated/);
  assert.match(await send('price-over-limit','PRICE slug:dune 1000000.01'), /maximum book price/);
  const [priced] = await db.select().from(schema.books).where(eq(schema.books.id, paperback.id));
  assert.equal(priced.priceCents, 100000000);
  assert.equal((await updateAdminBook(db, {...priced, price:'1000000.00', expected:priced})).priceCents, 100000000);
  await assert.rejects(updateAdminBook(db, {...priced, price:'1000000.01', expected:priced}), /Price is too large/);
 } finally {
  delete dbGlobal.folioDb;
 }
 console.log('Passed admin checks, atomic migration rollback, shared rate limits, and Discord confirmation ownership');
 }finally{await client.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
