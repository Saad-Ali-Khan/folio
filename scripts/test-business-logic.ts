import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import * as schema from '../lib/db/schema';
import type {Database} from '../lib/db';
import {importDiscordBook,executeCommand} from '../lib/discord-inventory';
async function main(){
 const client=new PGlite();
 try {
 for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) await client.exec(readFileSync('drizzle/'+f,'utf8').replaceAll('--> statement-breakpoint',''));
 const db=drizzle(client,{schema}) as unknown as Database;
 const meta={title:'Test edition',author:'Test author',isbn:'9780141037455',coverUrl:null};
 const first=await importDiscordBook(db,'one','channel',meta,3);assert(first);
 assert.equal(await importDiscordBook(db,'one','channel',meta,3),null);
 await importDiscordBook(db,'two','channel',meta,2);
 let [book]=await db.select().from(schema.books);assert.equal(book.stock,5);assert.equal(book.status,'draft');
 await assert.rejects(executeCommand(db,'oversell','channel','SOLD',book,6));
 await executeCommand(db,'sale','channel','SOLD',book,2);
 await executeCommand(db,'sale','channel','SOLD',book,2);
 [book]=await db.select().from(schema.books);assert.equal(book.stock,3);
 const movements=await db.select().from(schema.stockMovements);assert.equal(movements.reduce((n,m)=>n+m.delta,0),3);assert.equal(movements.length,3);
 await assert.rejects(client.exec("update books set status='published'"));
 await client.exec("update books set price_cents=1299,status='published'");
 await assert.rejects(client.exec("update books set price_cents=0"));
 await assert.rejects(client.exec("update books set stock=-1"));
 console.log('Passed: migrations, draft defaults, duplicate imports/sales, stock ledger, oversell rejection, publishing constraints');
 }finally{await client.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
