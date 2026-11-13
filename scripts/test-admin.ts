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
async function main(){
 process.env.ADMIN_PIN='test-only-pin';process.env.ADMIN_SESSION_SECRET='test-only-session-secret';
 const token=issueSession();assert(validSession(token));assert(!validSession(token+'x'));assert(!validSession(token,Date.now()+9*3600000));assert(validAdminPin('test-only-pin'));assert(!validAdminPin('incorrect'));
 assert(sameOrigin(new Request('http://localhost:3000/api/admin/books',{headers:{origin:'http://localhost:3000'}})));
 assert(!sameOrigin(new Request('http://localhost:3000/api/admin/books',{headers:{origin:'https://other.invalid'}})));
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
 const updated=await updateAdminBook(db,{...input,price:'1500',stock:7,status:'published'});
 assert.equal(updated.priceCents,150000);assert.equal(updated.status,'published');
 await assert.rejects(updateAdminBook(db,{...input,title:'Stale edit'}),e=>e instanceof AdminBookError&&e.status===409);
 const movements=await db.select().from(schema.stockMovements);assert.equal(movements.at(-1)?.reason,'admin inventory edit');assert.equal(movements.at(-1)?.delta,3);
 const draft=await updateAdminBook(db,{...updated,price:'1500',status:'draft',expected:updated});assert.equal(draft.status,'draft');
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
 console.log('Passed admin checks, atomic migration rollback, shared rate limits, and Discord confirmation ownership');
 }finally{await client.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
