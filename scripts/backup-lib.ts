import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { Database } from '../lib/db';
import { photoIdentity } from '../lib/photo-budget';

type Migration = { name: string; contents: string };
type Row = Record<string, unknown>;
export type Snapshot = {
  format: 'folio-data-v1'; createdAt: string; serverVersion: string;
  migrations: Migration[];
  tables: { name: string; columns: string[]; dependencies: string[]; rows: Row[]; digest: string }[];
  sequences: { name: string; lastValue: string; isCalled: boolean }[];
  objects?: { key: string; data: string }[];
};

export function validateBackupPhotos(snapshot: Snapshot) {
  const objects = new Map<string, Buffer>(); let bytes = 0;
  for (const object of snapshot.objects ?? []) {
    const data = Buffer.from(object.data, 'base64'); bytes += data.length;
    if (bytes > 64 * 1024 * 1024 || data.toString('base64') !== object.data || photoIdentity(data) !== object.key || objects.has(object.key)) throw Error('Invalid backup photo manifest or checksum.');
    objects.set(object.key, data);
  }
  const references = [
    ...(snapshot.tables.find(t => t.name === 'book_photos')?.rows.map(row => row.object_key) ?? []),
    ...(snapshot.tables.find(t => t.name === 'title_choices')?.rows.map(row => (row.metadata as {uploadedCoverKey?:string})?.uploadedCoverKey) ?? []),
  ].filter((key): key is string => typeof key === 'string' && Boolean(key));
  if (references.some(key => !objects.has(key))) throw Error('Invalid backup: referenced R2 photo is missing.');
  return objects;
}

export async function attachBackupPhotos(snapshot: Snapshot, get: (key: string) => Promise<Buffer>) {
  // Pending covers expire and are never inventory photos; do not resurrect them.
  const ready = snapshot.tables.find(t => t.name === 'photo_objects')?.rows.filter(row => row.state === 'ready' && String(row.key).startsWith('covers/')) ?? [];
  if (ready.reduce((sum, row) => sum + Number(row.bytes), 0) > 64 * 1024 * 1024) throw Error('Backup data exceeds the 64 MiB photo archive limit; use a dedicated object backup.');
  snapshot.objects = [];
  for (const row of ready) {
    const data = await get(String(row.key));
    if (data.length !== Number(row.bytes) || photoIdentity(data) !== row.key) throw Error('Invalid backup photo checksum.');
    snapshot.objects.push({ key: String(row.key), data: data.toString('base64') });
  }
  validateBackupPhotos(snapshot);
}
export const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function digest(rows: Row[]) {
  return createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');
}
function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as {rows:T[]}).rows) as T[];
}

export async function takeSnapshot(db: Database, migrations: Migration[]): Promise<Snapshot> {
  return db.transaction(async tx => {
    // All table reads share one snapshot; no production writes are permitted.
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    await tx.execute(sql`set local timezone = 'UTC'`);
    await tx.execute(sql`set local statement_timeout = '20s'`);
    const [{version}] = rows<{version:string}>(await tx.execute(sql`select current_setting('server_version') as version`));
    const [{bytes}] = rows<{bytes:string}>(await tx.execute(sql`select coalesce(sum(pg_total_relation_size(format('%I.%I',schemaname,tablename)::regclass)),0)::text as bytes from pg_tables where schemaname='public'`));
    if (Number(bytes) > 64*1024*1024) throw Error('Application data exceeds 64 MiB; use native pg_dump for a larger backup.');
    const names = rows<{name:string}>(await tx.execute(sql`select tablename as name from pg_tables where schemaname='public' order by tablename`));
    const tables: Snapshot['tables'] = [];
    for (const {name} of names) {
      const columns = rows<{name:string}>(await tx.execute(sql`select column_name as name from information_schema.columns where table_schema='public' and table_name=${name} order by ordinal_position`)).map(row=>row.name);
      const dependencies = rows<{name:string}>(await tx.execute(sql`select distinct parent.relname as name from pg_constraint c join pg_class child on child.oid=c.conrelid join pg_namespace ns on ns.oid=child.relnamespace join pg_class parent on parent.oid=c.confrelid where c.contype='f' and ns.nspname='public' and child.relname=${name}`)).map(row=>row.name);
      const data = rows<{payload:Row}>(await tx.execute(sql.raw(`select to_jsonb(t) as payload from public.${quote(name)} t`))).map(row=>row.payload);
      tables.push({name,columns,dependencies,rows:data,digest:digest(data)});
    }
    const sequenceNames = rows<{name:string}>(await tx.execute(sql`select sequencename as name from pg_sequences where schemaname='public' order by sequencename`));
    const sequences: Snapshot['sequences'] = [];
    for (const {name} of sequenceNames) {
      const [value] = rows<{value:string;called:boolean}>(await tx.execute(sql.raw(`select last_value::text as value,is_called as called from public.${quote(name)}`)));
      sequences.push({name,lastValue:value.value,isCalled:value.called});
    }
    const applied=new Set(tables.find(table=>table.name==='_folio_migrations')?.rows.map(row=>String(row.name))??[]);
    if(!applied.size||[...applied].some(name=>!migrations.some(migration=>migration.name===name)))throw Error('Backup requires every applied migration source file.');
    return {format:'folio-data-v1',createdAt:new Date().toISOString(),serverVersion:version,migrations:migrations.filter(migration=>applied.has(migration.name)),tables,sequences};
  });
}

export function seal(snapshot: Snapshot, key: Buffer): Buffer {
  validateBackupPhotos(snapshot);
  if (key.length !== 32) throw Error('Backup key must contain 32 bytes.');
  const json = Buffer.from(JSON.stringify(snapshot));
  if (json.length > 128*1024*1024) throw Error('Backup data exceeds the portable format limit; use pg_dump.');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(gzipSync(json)),cipher.final()]);
  return Buffer.concat([Buffer.from('FOLIOBK1'),iv,cipher.getAuthTag(),ciphertext]);
}

export function open(encrypted: Buffer,key: Buffer): Snapshot {
  if (key.length!==32 || encrypted.length<37 || encrypted.subarray(0,8).toString()!=='FOLIOBK1') throw Error('Invalid encrypted backup or key.');
  const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(8,20));
  decipher.setAuthTag(encrypted.subarray(20,36));
  const compressed=Buffer.concat([decipher.update(encrypted.subarray(36)),decipher.final()]);
  const snapshot=JSON.parse(gunzipSync(compressed,{maxOutputLength:128*1024*1024}).toString()) as Snapshot;
  if(snapshot.format!=='folio-data-v1'||!Array.isArray(snapshot.tables)||!Array.isArray(snapshot.migrations)||!Array.isArray(snapshot.sequences))throw Error('Unsupported backup format.');
  for(const table of snapshot.tables)if(digest(table.rows)!==table.digest)throw Error('Backup row checksum mismatch.');
  validateBackupPhotos(snapshot);
  return snapshot;
}

export async function verifyRestore(snapshot: Snapshot) {
  validateBackupPhotos(snapshot);
  // Deliberately accepts no connection string: this cannot overwrite production.
  const [{PGlite},{drizzle}]=await Promise.all([import('@electric-sql/pglite'),import('drizzle-orm/pglite')]);
  const isolated=new PGlite();
  try {
    const target=drizzle(isolated) as unknown as Database;
    try { await isolated.exec(recoverySql(snapshot, false)); }
    catch(error) { throw new Error('Schema drift or invalid recovery SQL.',{cause:error}); }
    const names=(await isolated.query<{name:string}>(`select tablename as name from pg_tables where schemaname='public' order by tablename`)).rows.map(row=>row.name).sort();
    if(canonical(names)!==canonical(snapshot.tables.map(table=>table.name).sort()))throw Error('Schema drift: migrations do not reproduce every source table.');
    const restored=await takeSnapshot(target,snapshot.migrations);
    for(const table of snapshot.tables){
      const actual=restored.tables.find(value=>value.name===table.name);
      if(actual&&canonical(actual.columns)!==canonical(table.columns))throw Error('Schema drift: column layout differs for '+table.name);
      if(!actual||actual.digest!==table.digest||actual.rows.length!==table.rows.length)throw Error('Restore checksum mismatch: '+table.name);
    }
    if(canonical(restored.sequences)!==canonical(snapshot.sequences))throw Error('Restored sequences do not match.');
    // Verify the original snapshot first, then prove recovery also works without R2.
    const hydration = photoRecoveryStatements(snapshot);
    if (hydration.length) {
      await isolated.exec(hydration.join('\n'));
      const photos = snapshot.tables.find(t => t.name === 'book_photos')?.columns.includes('object_key')
        ? (await isolated.query<{object_key:string;data:string}>('select object_key, data from book_photos where object_key is not null')).rows : [];
      for (const photo of photos) if (photoIdentity(Buffer.from(photo.data, 'base64')) !== photo.object_key) throw Error('Restore checksum mismatch: recovered R2 photo.');
      const choices = (await isolated.query<{metadata:{uploadedCoverKey:string;uploadedCover:string}}>("select metadata from title_choices where metadata->>'uploadedCoverKey' is not null")).rows;
      for (const {metadata} of choices) if (photoIdentity(Buffer.from(metadata.uploadedCover, 'base64')) !== metadata.uploadedCoverKey) throw Error('Restore checksum mismatch: recovered pending photo.');
    }
    return {tables:snapshot.tables.length,rows:snapshot.tables.reduce((sum,table)=>sum+table.rows.length,0),photos:snapshot.tables.find(table=>table.name==='book_photos')?.rows.length??0,objects:snapshot.objects?.length??0,sequences:snapshot.sequences.length,sourceVersion:snapshot.serverVersion,restoreVersion:restored.serverVersion};
  } finally { await isolated.close(); }
}

function literal(value: string) { return "'"+value.replaceAll("'","''")+"'"; }

/** Recovery script for a new empty Postgres database, never an in-place rollback. */
function photoRecoveryStatements(snapshot: Snapshot) {
  return (snapshot.objects ?? []).flatMap(object => [
    ...(snapshot.tables.find(t => t.name === 'book_photos')?.columns.includes('object_key') ? [`UPDATE public.book_photos SET data=${literal(object.data)} WHERE object_key=${literal(object.key)};`] : []),
    `UPDATE public.title_choices SET metadata=jsonb_set(metadata, '{uploadedCover}', to_jsonb(${literal(object.data)}::text)) WHERE metadata->>'uploadedCoverKey'=${literal(object.key)};`,
  ]);
}

export function recoverySql(snapshot: Snapshot, hydratePhotos = true): string {
  validateBackupPhotos(snapshot);
  const pending=[...snapshot.tables],ordered:Snapshot['tables']=[];
  while(pending.length){
    const index=pending.findIndex(table=>table.dependencies.every(name=>name===table.name||ordered.some(done=>done.name===name)));
    if(index<0)throw Error('Cyclic or unknown table dependencies; use native pg_dump.');
    ordered.push(...pending.splice(index,1));
  }
  const statements=[
    '-- Folio application recovery. Contains private customer data. Keep this file private.',
    'BEGIN;',
    "SET LOCAL standard_conforming_strings = on; SET LOCAL timezone = 'UTC'; SET LOCAL search_path = public, pg_catalog;",
    "DO $folio_empty$ BEGIN IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public') THEN RAISE EXCEPTION 'Recovery target is not empty; refusing to overwrite application data'; END IF; END $folio_empty$;",
    'CREATE TABLE public._folio_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());',
    ...snapshot.migrations.map(migration=>migration.contents+'\n;'),
    ...ordered.map(table=>`ALTER TABLE public.${quote(table.name)} DISABLE TRIGGER USER;`),
    ...ordered.filter(table=>table.rows.length).map(table=>{
      const columns=table.columns.map(quote).join(',');
      return `INSERT INTO public.${quote(table.name)} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(null::public.${quote(table.name)},${literal(JSON.stringify(table.rows))}::jsonb);`;
    }),
    ...ordered.map(table=>`ALTER TABLE public.${quote(table.name)} ENABLE TRIGGER USER;`),
    ...snapshot.sequences.map(sequence=>{
      if(!/^\d+$/.test(sequence.lastValue)||typeof sequence.isCalled!=='boolean')throw Error('Invalid backup sequence.');
      return `SELECT setval(${literal('public.'+quote(sequence.name))}::regclass,${sequence.lastValue}::bigint,${sequence.isCalled});`;
    }),
    ...(hydratePhotos ? photoRecoveryStatements(snapshot) : []),
    'COMMIT;',
  ];
  return statements.join('\n');
}
