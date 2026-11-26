import assert from 'node:assert/strict';
import { BACKUP_R2_LIMITS, uploadEncryptedBackup, type BackupTransport } from './backup-r2';

async function main() {
  const data=Buffer.from('encrypted archive fixture'), objects=new Map<string,Buffer>(), calls:string[]=[];
  const request:BackupTransport=async(method,key,body)=>{
    calls.push(method);
    if(key.startsWith('?'))return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects].map(([name,value])=>`<Contents><Key>${encodeURIComponent(name)}</Key><Size>${value.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    if(method==='PUT'){assert(body);assert(!objects.has(key));objects.set(key,body);return new Response(null);}
    assert.equal(method,'GET');return new Response(new Uint8Array(objects.get(key)!));
  };
  const first=await uploadEncryptedBackup(data,request);assert.equal(first.alreadyPresent,false);assert.deepEqual(first.downloaded,data);
  assert.deepEqual(calls,['GET','PUT','GET']);calls.length=0;
  assert.equal((await uploadEncryptedBackup(data,request)).alreadyPresent,true);assert.deepEqual(calls,['GET','GET']);
  for(const xml of ['<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>','bad',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>x</Key></Contents></ListBucketResult>']){
    await assert.rejects(uploadEncryptedBackup(data,async()=>new Response(xml)),/listing/);
  }
  const limited=(contents:string):BackupTransport=>async(method)=>{assert.equal(method,'GET');return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);};
  await assert.rejects(uploadEncryptedBackup(data,limited(`<Contents><Key>other</Key><Size>${BACKUP_R2_LIMITS.bytes}</Size></Contents>`)),/limit reached/);
  await assert.rejects(uploadEncryptedBackup(data,limited(Array.from({length:100},(_,i)=>`<Contents><Key>${i}</Key><Size>1</Size></Contents>`).join(''))),/limit reached/);
  await assert.rejects(uploadEncryptedBackup(data,async(method,key,body)=>key.startsWith('?')?request(method,key,body):new Response('corrupt')),/checksum/);
  await assert.rejects(uploadEncryptedBackup(Buffer.alloc(0),request),/size limit/);
  console.log('PASS backup R2 upload/download hash, retry deduplication, corrupt download, listing failure and storage/count bounds. No network, credentials or real backups used.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
