import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Database } from "../lib/db";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import { cleanupRetainedCovers, queueCoverBarcode, readRetainedCover, resolveCoverBarcode, retainFailedCover } from "../lib/pending-covers";
import { resolveTitleChoice } from "../lib/title-choice";
import { attachBackupPhotos, takeSnapshot, verifyRestore } from "./backup-lib";
import { GET as preview } from "../app/api/discord/inventory/cover-preview/route";
import { createCoverCleanupScheduler } from "../lib/cover-cleanup-scheduler";

async function main() {
 const engine=new PGlite(),db=drizzle(engine,{schema}) as unknown as Database;
 const originalFetch=globalThis.fetch,envBefore={...process.env};
 const globals=globalThis as typeof globalThis & {folioDb?:Promise<Database>};globals.folioDb=Promise.resolve(db);
 try {
  delete process.env.DATABASE_URL;
  const migrations=readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort().map(name=>({name,contents:readFileSync(`drizzle/${name}`,'utf8')}));await applyMigrations(db,migrations);
  const image=await sharp({create:{width:24,height:32,channels:3,background:'red'}}).webp().toBuffer();
  const blue=await sharp({create:{width:24,height:32,channels:3,background:'blue'}}).webp().toBuffer();
  const purple=await sharp({create:{width:24,height:32,channels:3,background:'purple'}}).webp().toBuffer();
  const objects=new Map<string,Buffer>();let puts=0,gets=0,deletes=0;
  const store={async put(key:string,data:Buffer){puts++;objects.set(key,data);},async get(key:string){gets++;const data=objects.get(key);if(!data)throw Error('missing');return data;},async deleteTemporary(key:string){assert.match(key,/^pending\//);deletes++;objects.delete(key);}};
  const meta=(isbn:string)=>({title:'Synthetic book '+isbn,author:'Test author',isbn,coverUrl:null});
  await retainFailedCover(db,'cover-one','channel','owner',image,3,store);
  const [retained]=await db.select().from(schema.pendingCovers);assert.equal(retained.state,'waiting');assert.match(retained.objectKey,/^pending\//);
  await retainFailedCover(db,'cover-one','channel','owner',image,3,store);assert.equal(puts,1);assert.equal((await db.select().from(schema.books)).length,0);
  const getBefore=gets;await assert.rejects(readRetainedCover(db,retained.id,'other','channel',store));await assert.rejects(readRetainedCover(db,retained.id,'owner','other',store));assert.equal(gets,getBefore);
  const choice=await queueCoverBarcode(db,'barcode-one','channel','owner',meta('9780805210552'),1);assert.ok(choice?.coverMatch);assert.match(choice.coverMatch.covers[0].label,/3 copies/);
  const otherChoice=await queueCoverBarcode(db,'barcode-repeat','channel','owner',meta('9780805210552'),1);assert.ok(otherChoice?.coverMatch);
  assert.match((await resolveCoverBarcode(db,choice.coverMatch.id,'channel','other',retained.id,store)).reply,/not found/);
  assert.equal((await db.select().from(schema.books)).length,0);
  const result=await resolveCoverBarcode(db,choice.coverMatch.id,'channel','owner',retained.id,store);assert.match(result.reply,/Received 3 copies/);
  await resolveCoverBarcode(db,choice.coverMatch.id,'channel','owner',retained.id,store);
  const [book]=await db.select().from(schema.books);assert.equal(book.stock,3);assert.equal((await db.select().from(schema.stockMovements)).length,1);
  assert.match((await resolveCoverBarcode(db,otherChoice.coverMatch.id,'channel','owner',retained.id,store)).reply,/expired|claimed/);
  const [photo]=await db.select().from(schema.bookPhotos);assert.equal(photo.data,'');assert.match(photo.objectKey!,/^covers\//);
  await cleanupRetainedCovers(db,store);assert.equal(objects.has(retained.objectKey),false);assert.equal(objects.has(photo.objectKey!),true);assert.equal(deletes,1);
  assert.equal((await db.select().from(schema.photoUploadMonths))[0].attempts,2);
  console.log('PASS retained photo adds no stock; account/channel checks; explicit confirmation receives retained quantity once; cleanup removes only temporary bytes');

  await retainFailedCover(db,'race-cover','channel','racer',image,1,store);
  const race=await queueCoverBarcode(db,'race-barcode','channel','racer',meta('9780140449136'),1);
  const clicks=await Promise.allSettled([resolveCoverBarcode(db,race!.coverMatch!.id,'channel','racer',race!.coverMatch!.covers[0].id,store),resolveCoverBarcode(db,race!.coverMatch!.id,'channel','racer',race!.coverMatch!.covers[0].id,store)]);
  assert.ok(clicks.some(c=>c.status==='fulfilled'));assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn,'9780140449136')))[0].stock,1);
  console.log('PASS simultaneous cover confirmations cannot add the same copy twice');

  await retainFailedCover(db,'cover-title','channel','titles',blue,1,store);
  const [coverTitle]=(await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.userId,'titles')));
  const titleMeta={...meta('9780141037455'),titleOptions:{english:'English choice',original:'Original choice'}};
  const prompt=await queueCoverBarcode(db,'barcode-title','channel','titles',titleMeta,1);
  const queued=await resolveCoverBarcode(db,prompt!.coverMatch!.id,'channel','titles',coverTitle.id,store);assert.ok(queued.titleChoiceId);
  assert.equal((await db.select().from(schema.books)).length,2);
  const pending=(await db.select().from(schema.titleChoices))[0];assert.equal(pending.metadata.uploadedCover,undefined);assert.match(pending.metadata.uploadedCoverKey!,/^covers\//);
  await resolveTitleChoice(db,queued.titleChoiceId!,'channel','titles','ENGLISH');await resolveTitleChoice(db,queued.titleChoiceId!,'channel','titles','ENGLISH');
  assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn,'9780141037455')))[0].stock,1);
  console.log('PASS cover confirmation composes with title selection; no stock before final title and no duplicate stock on replay');

  for(let i=0;i<4;i++)await retainFailedCover(db,'multi-'+i,'channel','multi',image,i+1,store);
  await assert.rejects(retainFailedCover(db,'multi-over','channel','multi',image,1,store),/Too many/);
  await retainFailedCover(db,'unrelated','channel','stranger',image,1,store);
  const multi=await queueCoverBarcode(db,'multi-barcode','channel','multi',meta('9780306406157'),2,true);assert.equal(multi!.coverMatch!.covers.length,4);assert.ok(multi!.coverMatch!.covers.every(c=>/2 copies/.test(c.label)));
  const confirmed=await resolveCoverBarcode(db,multi!.coverMatch!.id,'channel','multi',multi!.coverMatch!.covers[2].id,store);assert.match(confirmed.reply,/Received 2 copies/);
  const skip=await queueCoverBarcode(db,'skip-barcode','channel','multi',meta('9791234567896'),1);
  await resolveCoverBarcode(db,skip!.coverMatch!.id,'channel','multi','SKIP',store);assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn,'9791234567896')))[0].stock,1);
  const cancel=await queueCoverBarcode(db,'cancel-barcode','channel','multi',meta('9781400033416'),1);await resolveCoverBarcode(db,cancel!.coverMatch!.id,'channel','multi','CANCEL',store);
  assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn,'9781400033416'))).length,0);
  console.log('PASS bounded multiple-cover selection, explicit quantity override, barcode-only path and cancellation');

  process.env.R2_ACCOUNT_ID='a'.repeat(32);process.env.R2_ACCESS_KEY_ID='test-key';process.env.R2_SECRET_ACCESS_KEY='test-secret';process.env.INVENTORY_DISCORD_SECRET='test-secret';process.env.DISCORD_CHANNEL_ID='channel';
  globalThis.fetch=async input=>{assert.ok(input instanceof Request);const request=input as Request;assert.equal(request.method,'GET');const key=new URL(request.url).pathname.replace('/folio-photos/','');const data=objects.get(key);return new Response(data?new Uint8Array(data):null,{status:data?200:404});};
  const previewId=multi!.coverMatch!.covers[0].id;
  const request=(user:string,secret='test-secret')=>new Request('http://localhost/api/discord/inventory/cover-preview?id='+previewId,{headers:{'x-inventory-secret':secret,'x-channel-id':'channel','x-user-id':user}});
  assert.equal((await preview(request('multi','wrong'))).status,401);assert.equal((await preview(request('stranger'))).status,404);
  const imageResponse=await preview(request('multi'));assert.equal(imageResponse.status,200);assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),image);
  console.log('PASS retained-cover previews require the bot secret and matching account/channel');

  await retainFailedCover(db,'will-fail','channel','fail-owner',purple,1,store);
  const failedCover=(await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.userId,'fail-owner')))[0];
  const failedChoice=await queueCoverBarcode(db,'failed-barcode','channel','fail-owner',meta('9780141439518'),1);
  const failingStore={...store,async put(key:string){assert.match(key,/^covers\//);throw Error('lost PUT response');}};
  await assert.rejects(resolveCoverBarcode(db,failedChoice!.coverMatch!.id,'channel','fail-owner',failedCover.id,failingStore));
  assert.equal((await db.select().from(schema.books).where(eq(schema.books.isbn,'9780141439518'))).length,0);
  const lease=(await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.id,failedCover.id)))[0].expiresAt;
  await assert.rejects(resolveCoverBarcode(db,failedChoice!.coverMatch!.id,'channel','fail-owner',failedCover.id,store),/unresolved/);
  assert.deepEqual((await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.id,failedCover.id)))[0].expiresAt,lease);
  await db.update(schema.pendingCovers).set({expiresAt:new Date(0)}).where(eq(schema.pendingCovers.id,failedCover.id));
  await assert.rejects(readRetainedCover(db,failedCover.id,'fail-owner','channel',store),/expired/);
  let failedDeleteKey='';
  await assert.rejects(cleanupRetainedCovers(db,{...store,async deleteTemporary(key:string){failedDeleteKey=key;throw Error('temporary delete failed');}}));
  assert.ok((await db.select().from(schema.photoObjects).where(eq(schema.photoObjects.key,failedDeleteKey))).length);
  await db.update(schema.pendingCovers).set({expiresAt:new Date(0)}).where(eq(schema.pendingCovers.id,failedCover.id));
  await cleanupRetainedCovers(db,store);assert.equal(objects.has(failedCover.objectKey),false);assert.equal(objects.has(photo.objectKey!),true);
  console.log('PASS failed promotion leaves stock unchanged; replay cannot extend the processing lease; expiry denies access; failed deletion retains budget capacity');

  globalThis.fetch=async input=>{const request=input as Request;assert.equal(request.method,'DELETE');const key=new URL(request.url).pathname.replace('/folio-photos/','');assert.match(key,/^pending\//);objects.delete(key);return new Response(null,{status:204});};
  let databaseCalls=0,cleanupNotice:(()=>void)|undefined;
  const scheduler=createCoverCleanupScheduler(async()=>{databaseCalls++;return db;},line=>{if(line.startsWith('Expired retained-cover'))cleanupNotice?.();});
  try {
   await scheduler.start();const initialCalls=databaseCalls;
   await new Promise(resolve=>setTimeout(resolve,650));assert.equal(databaseCalls,initialCalls,'scheduler must not poll while waiting for known expiry');
   const waiting=(await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.state,'waiting')))[0];
   await db.update(schema.pendingCovers).set({expiresAt:new Date(0)}).where(eq(schema.pendingCovers.id,waiting.id));
   await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('cleanup event did not run')),5000);cleanupNotice=()=>{clearTimeout(timeout);resolve();};scheduler.schedule(Date.now());});
   assert.ok((await db.select().from(schema.pendingCovers).where(eq(schema.pendingCovers.id,waiting.id)))[0].cleanedAt);
   assert.equal(objects.has(waiting.objectKey),false);assert.equal(objects.has(photo.objectKey!),true);
  } finally {scheduler.stop();}
  console.log('PASS expiry scheduler sleeps without polling and wakes to delete a due temporary object while preserving permanent photos');

  const snapshot=await takeSnapshot(db,migrations);await attachBackupPhotos(snapshot,async key=>{assert.match(key,/^covers\//);return objects.get(key)!;});
  assert.ok(snapshot.objects!.every(o=>o.key.startsWith('covers/')));await verifyRestore(snapshot);
  console.log('PASS encrypted-backup manifest includes permanent images and excludes expiring temporary covers');
 } finally {globalThis.fetch=originalFetch;process.env=envBefore;delete globals.folioDb;await engine.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
