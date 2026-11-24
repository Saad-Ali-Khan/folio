import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {drizzle} from "drizzle-orm/pglite";
import {eq} from "drizzle-orm";
import sharp from "sharp";
import type {Database} from "../lib/db";
import * as schema from "../lib/db/schema";
import {applyMigrations} from "../lib/db/migrations";
import {copyPhoto} from "../lib/photo-budget";
import {attachBackupPhotos,takeSnapshot,verifyRestore} from "./backup-lib";
import {preparePhotoReclamation,reclaimPhotoPayloads} from "./photo-reclamation-lib";
import {queueTitleChoice} from "../lib/title-choice";

async function main(){
 const engine=new PGlite(),db=drizzle(engine,{schema}) as unknown as Database;
 try{
  const migrations=readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort().map(name=>({name,contents:readFileSync(`drizzle/${name}`,'utf8')}));await applyMigrations(db,migrations);
  const image=await sharp({create:{width:20,height:20,channels:3,background:'gold'}}).webp().toBuffer(),base64=image.toString('base64');
  const map=new Map<string,Buffer>(),store={async put(key:string,data:Buffer){map.set(key,data);},async get(key:string){return map.get(key)!;}};
  const {key}=await copyPhoto(db,image,store);
  const [book]=await db.insert(schema.books).values({isbn:'reclaim-test',slug:'reclaim-test',title:'Test',author:'Test',stock:2,priceCents:0}).returning();
  await db.insert(schema.bookPhotos).values({bookId:book.id,data:base64,objectKey:key});
  const metadata={title:'Test',author:'Test',isbn:null,coverUrl:null,uploadedCover:base64,titleOptions:{english:'Test',original:'Original'}};
  await queueTitleChoice(db,'expired','channel','owner',metadata,1);await queueTitleChoice(db,'active','channel','owner',metadata,1);
  const expired=(await db.select().from(schema.titleChoices).where(eq(schema.titleChoices.sourceMessageId,'expired')))[0];
  await db.update(schema.titleChoices).set({expiresAt:new Date(0)}).where(eq(schema.titleChoices.id,expired.id));
  const counts=await preparePhotoReclamation(db,store);assert.deepEqual(counts,{photos:1,titleChoices:1});
  const snapshot=await takeSnapshot(db,migrations);await attachBackupPhotos(snapshot,async k=>map.get(k)!);await verifyRestore(snapshot);
  const absent=structuredClone(snapshot);absent.objects=[];await assert.rejects(reclaimPhotoPayloads(db,absent,async()=>image));
  await assert.rejects(reclaimPhotoPayloads(db,snapshot,async()=>Buffer.from('corrupt')));
  assert.equal((await db.select().from(schema.bookPhotos))[0].data,base64);
  const result=await reclaimPhotoPayloads(db,snapshot,async k=>map.get(k)!);assert.equal(result.photos,1);assert.equal(result.titleChoices,1);assert.equal(result.payloadBytesReclaimed,base64.length*2);
  assert.equal((await db.select().from(schema.bookPhotos))[0].data,'');assert.equal((await db.select().from(schema.books))[0].stock,2);
  const rows=await db.select().from(schema.titleChoices);assert.equal(rows.find(r=>r.sourceMessageId==='active')!.metadata.uploadedCover,base64);assert.equal(rows.find(r=>r.sourceMessageId==='expired')!.metadata.uploadedCover,undefined);assert.equal(rows.find(r=>r.sourceMessageId==='expired')!.metadata.uploadedCoverKey,key);
  assert.deepEqual(await reclaimPhotoPayloads(db,snapshot,async k=>map.get(k)!),{photos:0,titleChoices:0,payloadBytesReclaimed:0});
  await verifyRestore(snapshot);
  console.log('PASS cleanup requires matching archive and live bytes, preserves active choices and stock, removes duplicate payloads once, and leaves offline recovery intact');
 }finally{await engine.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
