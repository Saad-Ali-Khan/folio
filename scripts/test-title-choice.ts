import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {eq} from 'drizzle-orm';
import {readFileSync,readdirSync} from 'node:fs';
import * as schema from '../lib/db/schema';
import type {Database} from '../lib/db';
import {lookupImportMetadata} from '../lib/import-metadata';
import {queueTitleChoice,resolveTitleChoice} from '../lib/title-choice';
async function main(){
 const originalFetch=global.fetch;
 const isbn='9780141037455';
 const catalog={key:'/works/OL123W',title:'El amor en los tiempos del cólera',author_name:['Gabriel García Márquez'],editions:{docs:[{title:'El amor en los tiempos del cólera',language:['spa']}]}};
 global.fetch=async(input)=>{const url=new URL(String(input));return Response.json({docs:[url.searchParams.has('isbn')?catalog:{...catalog,editions:{docs:[{title:'Love in the Time of Cholera',language:['eng'],isbn:['DIFFERENT-EDITION']}]}}]});};
 let meta;
 try{
  meta=await lookupImportMetadata({isbn});assert(meta);assert.equal(meta.title,'Love in the Time of Cholera');assert.equal(meta.isbn,isbn);assert.equal(meta.titleOptions?.original,catalog.title);assert(meta.coverUrl?.includes(isbn));
  global.fetch=async(input)=>{const url=new URL(String(input));if(url.searchParams.has('q'))throw Error('offline');return Response.json({docs:[catalog]});};
  const fallback=await lookupImportMetadata({isbn});assert(fallback?.titleNote);assert.equal(fallback?.titleOptions,undefined);assert.equal(fallback?.title,catalog.title);
  global.fetch=async()=>Response.json({docs:[{key:'/works/OL42W',title:'Dune',editions:{docs:[{title:'Dune',language:['eng']}]}}]});
  assert.equal((await lookupImportMetadata({isbn}))?.titleOptions,undefined);
 }finally{global.fetch=originalFetch;}
 const client=new PGlite();try{
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())await client.exec(readFileSync('drizzle/'+f,'utf8'));
  const db=drizzle(client,{schema}) as unknown as Database;
  await queueTitleChoice(db,'scan','channel','operator',meta!,2);
  assert.equal((await db.select().from(schema.books)).length,0,'no stock until choice');
  const [choice]=await db.select().from(schema.titleChoices);
  assert.match((await resolveTitleChoice(db,choice.id,'channel','someone-else','ENGLISH')).reply,/not found/);
  await resolveTitleChoice(db,choice.id,'channel','operator','ENGLISH');await resolveTitleChoice(db,choice.id,'channel','operator','ORIGINAL');
  const [book]=await db.select().from(schema.books);assert.equal(book.stock,2);assert.equal(book.title,meta!.title);assert.equal(book.isbn,isbn);
  await queueTitleChoice(db,'review','channel','operator',meta!,0,book.id);
  const [review]=await db.select().from(schema.titleChoices).where(eq(schema.titleChoices.sourceMessageId,'review'));
  await resolveTitleChoice(db,review.id,'channel','operator','ORIGINAL');
  const [renamed]=await db.select().from(schema.books);assert.equal(renamed.title,catalog.title);assert.equal(renamed.stock,2);assert.equal(renamed.slug,book.slug);assert.equal(renamed.isbn,isbn);
  await queueTitleChoice(db,'cancel','channel','operator',meta!,5);
  const [cancel]=await db.select().from(schema.titleChoices).where(eq(schema.titleChoices.sourceMessageId,'cancel'));
  await resolveTitleChoice(db,cancel.id,'channel','operator','CANCEL');assert.equal((await db.select().from(schema.books))[0].stock,2);
  await queueTitleChoice(db,'expired','channel','operator',meta!,3);
  const [expired]=await db.update(schema.titleChoices).set({expiresAt:new Date(0)}).where(eq(schema.titleChoices.sourceMessageId,'expired')).returning();
  assert.match((await resolveTitleChoice(db,expired.id,'channel','operator','ENGLISH')).reply,/expired/);assert.equal((await db.select().from(schema.books))[0].stock,2);
  console.log('Passed: English preference, same-work editions, unchanged ISBN/cover, offline fallback, confirmation ownership, persistence, retries, existing-book title review, cancellation and expiry');
 }finally{await client.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
