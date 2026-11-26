import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../lib/db';
import { attachBackupPhotos, open, recoverySql, seal, takeSnapshot, verifyRestore } from './backup-lib';
import { readObjectPhoto } from '../lib/book-photos';
import { backupTransport, uploadEncryptedBackup } from './backup-r2';

function recoveryKey(create: boolean) {
  let encoded=process.env.FOLIO_BACKUP_KEY?.trim();
  const keyPath=path.resolve('.folio-backup-key');
  if(!encoded){
    if(!existsSync(keyPath)){
      if(!create)throw Error('Recovery key missing. Recover the original .folio-backup-key; a new key cannot open old backups.');
      writeFileSync(keyPath,randomBytes(32).toString('base64')+'\n',{flag:'wx',mode:0o600});
      console.log('Created .folio-backup-key. Keep a separate safe copy; it is required to decrypt backups.');
    }
    encoded=readFileSync(keyPath,'utf8').trim();
  }
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw Error('Backup key must be a base64-encoded 32-byte key.');
  return Buffer.from(encoded,'base64');
}

async function main(){
  const [command,filename]=process.argv.slice(2);
  if(!['create','verify','upload','recover-sql'].includes(command))throw Error('Usage: npm run backup:create | npm run backup:upload -- FILE | npm run backup:verify -- FILE | npm run backup:recover-sql -- FILE --allow-plaintext');
  const key=recoveryKey(command==='create');
  let destination:string;
  if(command==='create'){
    if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required; refusing to back up an accidental empty local database.');
    const migrations=readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort().map(name=>({name,contents:readFileSync(path.join('drizzle',name),'utf8')}));
    const {db,close}=await createDatabase();
    let snapshot;
    try{
      snapshot=await takeSnapshot(db,migrations);
      await attachBackupPhotos(snapshot, key => readObjectPhoto(db, key));
    }finally{await close();}
    const directory=path.resolve('.folio-backups');mkdirSync(directory,{recursive:true});
    destination=path.join(directory,`folio-${new Date().toISOString().replaceAll(':','-')}-${randomBytes(3).toString('hex')}.foliobackup`);
    const temporary=destination+'.tmp';
    writeFileSync(temporary,seal(snapshot,key),{flag:'wx',mode:0o600});renameSync(temporary,destination);
    console.log('Encrypted application backup saved: '+destination);
  }else{
    const selected=filename??(command==='upload'?readdirSync('.folio-backups').filter(name=>/^folio-\d{4}-\d{2}-\d{2}T.*\.foliobackup$/.test(name)).sort().at(-1):undefined);
    if(!selected)throw Error('Provide the backup file to verify.');
    destination=path.resolve(filename??path.join('.folio-backups',selected));
  }
  const snapshot=open(readFileSync(destination),key);
  if(command==='recover-sql'){
    if(!process.argv.includes('--allow-plaintext'))throw Error('Recovery SQL contains private data. Add --allow-plaintext only when ready to recover into a new empty database.');
    await verifyRestore(snapshot);
    const output=destination+'.recovery.sql';
    writeFileSync(output,recoverySql(snapshot),{flag:'wx',mode:0o600});
    console.log('Private plaintext recovery SQL saved: '+output);
    console.log('Run with psql -X -v ON_ERROR_STOP=1 against a NEW EMPTY database. The script refuses a nonempty public schema.');
    return;
  }
  const report=await verifyRestore(snapshot);
  writeFileSync(destination+'.verified.json',JSON.stringify({verifiedAt:new Date().toISOString(),isolation:'in-memory PGlite; no production restore',...report},null,2)+'\n',{mode:0o600});
  console.log(`PASS isolated restore: ${report.tables} tables, ${report.rows} rows, ${report.photos} photos, ${report.objects} archived R2 objects, ${report.sequences} sequences; every table checksum matched; photo fallback recovery verified.`);
  console.log('Business data was read only. R2 reads update the usage budget. Backup excludes database roles, account settings, and runtime secrets.');
  if(command==='upload'){
    const directory=path.resolve('.folio-backups');mkdirSync(directory,{recursive:true});
    const lock=path.join(directory,'r2-upload.lock');
    // One local uploader, fail closed after interruption; never silently clear a stale lock.
    writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    try{
      const usageFile=path.join(directory,'r2-requests.json'), month=new Date().toISOString().slice(0,7);
      let usage:{month:string;requests:number}=existsSync(usageFile)?JSON.parse(readFileSync(usageFile,'utf8')):{month,requests:0};
      if(!/^\d{4}-\d{2}$/.test(usage.month)||!Number.isSafeInteger(usage.requests)||usage.requests<0||usage.month>month)throw Error('Backup R2 request ledger invalid; upload stopped.');
      if(usage.month!==month)usage={month,requests:0};
      const reserve=()=>{
        if(usage.requests>=200)throw Error('Backup R2 monthly request limit reached; local archive retained.');
        usage.requests++;
        const temporary=usageFile+'.tmp';writeFileSync(temporary,JSON.stringify(usage),{mode:0o600});renameSync(temporary,usageFile);
      };
      const result=await uploadEncryptedBackup(readFileSync(destination),backupTransport(reserve));
      await verifyRestore(open(result.downloaded,key));
      const {downloaded: _downloaded,...receipt}=result;void _downloaded;
      writeFileSync(destination+'.r2.json',JSON.stringify({verifiedAt:new Date().toISOString(),bucket:'folio-backups',...receipt},null,2)+'\n',{mode:0o600});
      console.log(`PASS off-device download checksum and isolated restore: folio-backups/${result.key}; ${result.bytes} bytes. Recovery key was not uploaded.`);
    }finally{unlinkSync(lock);}
  }
}
main().catch(error=>{
  const message=error instanceof Error?error.message.split('\n')[0]:'';
  if(/^(Backup R2|Usage:|Recovery key|Backup key|DATABASE_URL|Provide the|Recovery SQL contains|Application data exceeds|Backup data exceeds|Backup requires|Schema drift|Restore checksum|Restored sequences|Unsupported backup|Invalid encrypted|Invalid backup|Cyclic or unknown)/.test(message))console.error(message);
  console.error('Backup or restore verification failed. The encrypted archive, if created, is retained. Check the recovery key, source connection, and schema compatibility.');
  process.exitCode=1;
});
