import assert from 'node:assert/strict';
import { planRetention, retentionDay, createRetentionPreview } from './backup-retention';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seal } from './backup-lib';

const archive=(name:string,date:string)=>({name,createdAt:date,bytes:100,sha256:'a'.repeat(64)});
assert.equal(retentionDay('2026-11-26T02:00:00Z'),'2026-11-25');
assert.equal(retentionDay('2026-07-01T03:00:00Z'),'2026-06-30');
const rows=Array.from({length:60},(_,i)=>archive(`book-${i}`,new Date(Date.UTC(2026,10,26-i,12)).toISOString()));
const plan=planRetention(rows);
assert.equal(plan.filter(row=>row.reason==='daily').length,7);
assert.equal(plan.filter(row=>row.reason==='weekly').length,4);
assert.equal(plan.filter(row=>row.action==='keep').length,11);
assert.equal(plan.find(row=>row.name==='book-0')!.action,'keep');
const duplicates=planRetention([archive('early','2026-11-26T12:00:00Z'),archive('late','2026-11-26T14:00:00Z')]);
assert.equal(duplicates.find(row=>row.name==='late')!.action,'keep');
assert.equal(duplicates.find(row=>row.name==='early')!.action,'review-removal');
const gaps=planRetention([archive('old','2020-01-01T12:00:00Z')]);
assert.equal(gaps[0].action,'keep','last backup never expires merely because creation stopped');
assert.deepEqual(planRetention([]),[]);
assert.throws(()=>planRetention([archive('same','2026-01-01'),archive('same','2026-01-02')]),/Duplicate/);
assert.throws(()=>retentionDay('invalid'),/Invalid/);
const input=structuredClone(rows);planRetention(rows);assert.deepEqual(rows,input);
const directory=mkdtempSync(path.join(tmpdir(),'folio-retention-test-')), previousKey=process.env.FOLIO_BACKUP_KEY;
try {
  const key=Buffer.alloc(32,7);process.env.FOLIO_BACKUP_KEY=key.toString('base64');
  const good='folio-2026-01-01T12-00-00.000Z-abcdef.foliobackup';
  const data=seal({format:'folio-data-v1',createdAt:'2026-01-01T12:00:00Z',serverVersion:'test',migrations:[],tables:[],sequences:[]},key);
  writeFileSync(path.join(directory,good),data);
  writeFileSync(path.join(directory,good+'.verified.json'),JSON.stringify({isolation:'in-memory PGlite; no production restore',verifiedAt:'2026-01-01T12:01:00Z'}));
  writeFileSync(path.join(directory,'manual-reference.foliobackup'),data);
  const corrupt='folio-2026-01-02T12-00-00.000Z-abcdef.foliobackup';writeFileSync(path.join(directory,corrupt),'corrupt');
  const unverified='folio-2026-01-03T12-00-00.000Z-abcdef.foliobackup';writeFileSync(path.join(directory,unverified),data);
  const preview=createRetentionPreview(directory);assert.equal(preview.summary.keep,1);assert.equal(preview.summary.protected,3);assert.equal(preview.summary.reviewRemoval,0);
  assert.deepEqual(readFileSync(path.join(directory,good)),data,'preview preserves archive bytes');
  process.env.FOLIO_BACKUP_KEY=Buffer.alloc(32,8).toString('base64');
  const changed=createRetentionPreview(directory);assert.equal(changed.rows.length,0);assert.equal(changed.summary.protected,4);
} finally {
  if(previousKey===undefined)delete process.env.FOLIO_BACKUP_KEY;else process.env.FOLIO_BACKUP_KEY=previousKey;
  // Only known flat fixture files are removed; never recurse through real backups.
  for(const name of readdirSync(directory))unlinkSync(path.join(directory,name));rmdirSync(directory);
}
console.log('PASS seven daily/four older weekly points, Toronto boundaries/DST, gaps, duplicate days, invalid/unverified/manual archive protection and non-destructive preview. No real backups or remote objects changed.');
