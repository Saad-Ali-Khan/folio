import assert from 'node:assert/strict';
import {readCatalogCover} from '../lib/publisher-cover';

async function main(){
 const original='https://covers.openlibrary.org/b/id/9273490-L.jpg?default=false';
 const archive='https://archive.org/download/l_covers_0009/l_covers_0009_27.zip/0009273490-L.jpg';
 const shard='https://ia600507.us.archive.org/view_archive.php?archive=/8/items/l_covers_0009/l_covers_0009_27.zip&file=0009273490-L.jpg';
 const seen:string[]=[];
 const request=(async(url: string|URL|Request, options?:RequestInit)=>{
  const target=String(url);seen.push(target);assert.equal(options?.redirect,'manual');
  return target===original?new Response(null,{status:302,headers:{location:archive}}):target===archive?
   new Response(null,{status:302,headers:{location:shard}}):new Response('jpeg fixture',{headers:{'content-type':'image/jpeg'}});
 }) as typeof fetch;
 assert.equal((await readCatalogCover(original,AbortSignal.timeout(1000),100,request)).toString(),'jpeg fixture');
 assert.deepEqual(seen,[original,archive,shard]);
 const old='https://covers.openlibrary.org/b/id/1011105-L.jpg?default=false';
 const oldArchive='https://archive.org/download/olcovers101/olcovers101-L.zip/1011105-L.jpg';
 const oldShard='https://ia800507.us.archive.org/view_archive.php?archive=/8/items/olcovers101/olcovers101-L.zip&file=1011105-L.jpg';
 assert.equal((await readCatalogCover(old,AbortSignal.timeout(1000),100,(async input=>String(input)===old?
  new Response(null,{status:302,headers:{location:oldArchive}}):String(input)===oldArchive?
  new Response(null,{status:302,headers:{location:oldShard}}):new Response('legacy jpeg',{headers:{'content-type':'image/jpeg'}})) as typeof fetch)).toString(),'legacy jpeg');
 for(const bad of ['http://archive.org/download/x','https://127.0.0.1/private','https://archive.org.evil.test/download/x',
  archive.replace('0009273490','0009273491'),archive+'?extra=1',shard+'&extra=1',shard.replace('ia600507.us.archive.org','evil.archive.org'),
  shard.replace('/8/items/','/8/private/'),shard.replace('file=0009273490','file=0009273491'),shard.replace('archive=','file=bad&archive='),
  'https://user:password@archive.org/download/x',shard.replace('https:','http:')]){
  let calls=0;
  await assert.rejects(readCatalogCover(original,AbortSignal.timeout(1000),100,(async()=>{calls++;return new Response(null,{status:302,headers:{location:bad}});}) as typeof fetch),/Untrusted/);
  assert.equal(calls,1,'invalid target is rejected before any request');
 }
 await assert.rejects(readCatalogCover(original,AbortSignal.timeout(1000),100,(async()=>new Response(null,{status:302,headers:{location:original}})) as typeof fetch),/Untrusted/);
 await assert.rejects(readCatalogCover(original,AbortSignal.timeout(1000),3,(async()=>new Response('too large',{headers:{'content-type':'image/jpeg'}})) as typeof fetch),/too large/);
 await assert.rejects(readCatalogCover(original,AbortSignal.timeout(1000),100,(async()=>new Response('not image',{headers:{'content-type':'text/html'}})) as typeof fetch),/image/);
 await assert.rejects(readCatalogCover(original,AbortSignal.timeout(1000),100,(async()=>new Response(null,{status:404})) as typeof fetch),/unavailable/);
 console.log('PASS bounded Open Library/Internet Archive cover redirect chain, fixed image identity, hostile hosts/paths/queries, loops, non-images, size limits and missing covers. No network used.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
