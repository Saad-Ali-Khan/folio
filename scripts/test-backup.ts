import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../lib/db';
import { applyMigrations } from '../lib/db/migrations';
import * as schema from '../lib/db/schema';
import { open, recoverySql, seal, takeSnapshot, verifyRestore } from './backup-lib';

async function main(){
  const engine=new PGlite();
  try{
    const db=drizzle(engine,{schema}) as unknown as Database;
    const migrations=readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort().map(name=>({name,contents:readFileSync('drizzle/'+name,'utf8')}));
    await applyMigrations(db,migrations);
    const [book]=await db.insert(schema.books).values({isbn:'backup-fixture',slug:'backup-fixture',title:'Backup fixture',author:'Test author',priceCents:10000,stock:3,status:'draft'}).returning();
    await db.insert(schema.bookPhotos).values({bookId:book.id,data:Buffer.from('test-photo-bytes').toString('base64')});
    const [unused]=await db.insert(schema.books).values({isbn:'unused-backup-fixture',slug:'unused-backup-fixture',title:'Deleted fixture',author:'Test author',priceCents:0}).returning();
    await db.delete(schema.books).where(eq(schema.books.id,unused.id));
    const [order]=await db.insert(schema.orders).values({paymentMethod:'cod',status:'cash_due',totalCents:10000,shippingAddress:{name:'Synthetic buyer',address:{line1:'Synthetic address',city:'Test',country:'PK'}}}).returning();
    await db.insert(schema.orderItems).values({orderId:order.id,bookId:book.id,title:book.title,priceCents:10000,qty:1});
    const snapshot=await takeSnapshot(db,[...migrations,{name:'9999_unapplied.sql',contents:'create table not_yet_deployed(id integer);'}]);
    assert(!snapshot.migrations.some(migration=>migration.name==='9999_unapplied.sql'),'pre-migration backup includes only applied schema');
    assert(snapshot.sequences.some(sequence=>sequence.name==='books_id_seq'&&Number(sequence.lastValue)>book.id),'sequence preserves gaps from deleted records');
    const key=randomBytes(32),encrypted=seal(snapshot,key);
    assert(!encrypted.includes(Buffer.from('Synthetic buyer')),'backup must not contain plaintext customer details');
    assert.throws(()=>open(encrypted,randomBytes(32)),'wrong keys cannot decrypt');
    const damaged=Buffer.from(encrypted);damaged[damaged.length-1]^=1;
    assert.throws(()=>open(damaged,key),'tampered ciphertext must be rejected');
    const report=await verifyRestore(open(encrypted,key));
    assert.equal(report.tables,snapshot.tables.length);assert.equal(report.photos,1);
    const recoveryTarget=new PGlite();
    try{
      await recoveryTarget.exec(recoverySql(snapshot));
      const recovered=await takeSnapshot(drizzle(recoveryTarget) as unknown as Database,migrations);
      for(const table of snapshot.tables)assert.equal(recovered.tables.find(value=>value.name===table.name)?.digest,table.digest,'recovery SQL preserves every table');
      assert.deepEqual(recovered.sequences,snapshot.sequences);
      await assert.rejects(recoveryTarget.exec(recoverySql(snapshot)),/not empty/,'recovery SQL must refuse an existing database');
      await recoveryTarget.exec('rollback');
    }finally{await recoveryTarget.close();}
    assert.equal((await db.select().from(schema.books))[0].stock,3,'restore must not mutate the source');
    await db.execute(sql`create table unexpected_backup_drift(id integer)`);
    await assert.rejects(verifyRestore(await takeSnapshot(db,migrations)),/Schema drift/,'untracked schema must not be reported as recoverable');
    console.log('Passed: encryption and tamper rejection, full data/photo/sequence restore, recovery SQL, nonempty-target refusal, source isolation, and schema-drift detection');
  }finally{await engine.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
