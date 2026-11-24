import { and, eq, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../lib/db";
import { bookPhotos, titleChoices } from "../lib/db/schema";
import { copyPhoto, photoIdentity } from "../lib/photo-budget";
import { createR2PhotoStore, type R2PhotoStore } from "../lib/r2-photo-store";
import { readObjectPhoto } from "../lib/book-photos";
import { canonical, validateBackupPhotos, type Snapshot } from "./backup-lib";

async function eligibleChoices(db: Database) {
 return db.select().from(titleChoices).where(and(sql`${titleChoices.metadata}->>'uploadedCover' is not null`,or(ne(titleChoices.state,"pending"),lte(titleChoices.expiresAt,new Date()))));
}

export async function preparePhotoReclamation(db: Database, store:Pick<R2PhotoStore,"put"|"get">=createR2PhotoStore()) {
 const photos=await db.select().from(bookPhotos).where(ne(bookPhotos.data,""));
 const choices=await eligibleChoices(db);
 for(const data of [...photos.map(p=>p.data),...choices.map(c=>c.metadata.uploadedCover!)]) await copyPhoto(db,Buffer.from(data,"base64"),store);
 return {photos:photos.length,titleChoices:choices.length};
}

/** Requires an authenticated, restore-verified archive supplied by the CLI. */
export async function reclaimPhotoPayloads(db: Database, snapshot: Snapshot, read:(key:string)=>Promise<Buffer>=(key)=>readObjectPhoto(db,key)) {
 const archived=validateBackupPhotos(snapshot);
 const photos=await db.select().from(bookPhotos).where(ne(bookPhotos.data,""));
 const choices=await eligibleChoices(db);
 const archivedPhotos=snapshot.tables.find(t=>t.name==="book_photos")?.rows??[];
 const archivedChoices=snapshot.tables.find(t=>t.name==="title_choices")?.rows??[];
 const verified=new Set<string>();
 async function verify(key:string,data:string){
  const bytes=Buffer.from(data,"base64");
  if(bytes.toString("base64")!==data || photoIdentity(bytes)!==key || !archived.get(key)?.equals(bytes))throw new Error("Current image is not covered by the supplied backup.");
  if(!verified.has(key)){
   const remote=await read(key);if(photoIdentity(remote)!==key||!remote.equals(bytes))throw new Error("Live R2 bytes differ from the archived original.");verified.add(key);
  }
 }
 for(const photo of photos){
  const original=archivedPhotos.find(p=>p.book_id===photo.bookId);
  if(!photo.objectKey||original?.data!==photo.data||original?.object_key!==photo.objectKey)throw new Error("Listing photo changed since the supplied backup.");
  await verify(photo.objectKey,photo.data);
 }
 for(const choice of choices){
  const original=archivedChoices.find(c=>c.id===choice.id);
  if(!original||canonical(original.metadata)!==canonical(choice.metadata))throw new Error("Title choice changed since the supplied backup.");
  await verify(photoIdentity(Buffer.from(choice.metadata.uploadedCover!,"base64")),choice.metadata.uploadedCover!);
 }
 const result=await db.transaction(async tx=>{
  let bytes=0;
  for(const photo of photos){
   const changed=await tx.update(bookPhotos).set({data:""}).where(and(eq(bookPhotos.bookId,photo.bookId),eq(bookPhotos.data,photo.data),eq(bookPhotos.objectKey,photo.objectKey!))).returning();
   if(!changed.length)throw new Error("Photo changed during cleanup; nothing was reclaimed.");bytes+=Buffer.byteLength(photo.data);
  }
  for(const choice of choices){
   const metadata={...choice.metadata,uploadedCoverKey:photoIdentity(Buffer.from(choice.metadata.uploadedCover!,"base64"))};delete metadata.uploadedCover;
   const changed=await tx.update(titleChoices).set({metadata}).where(and(eq(titleChoices.id,choice.id),eq(titleChoices.metadata,choice.metadata),or(ne(titleChoices.state,"pending"),lte(titleChoices.expiresAt,new Date())))).returning();
   if(!changed.length)throw new Error("Title choice changed during cleanup; nothing was reclaimed.");bytes+=Buffer.byteLength(choice.metadata.uploadedCover!);
  }
  return {photos:photos.length,titleChoices:choices.length,payloadBytesReclaimed:bytes};
 });
 return result;
}
