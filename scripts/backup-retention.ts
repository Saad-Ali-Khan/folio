import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { open } from './backup-lib';

export type RetentionArchive = { name: string; createdAt: string; bytes: number; sha256: string };
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
export function retentionDay(date: string) {
  if (!Number.isFinite(Date.parse(date))) throw Error('Invalid backup timestamp.');
  const parts = dateFormat.formatToParts(new Date(date));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function week(day: string) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function planRetention(archives: RetentionArchive[]) {
  if (new Set(archives.map(row => row.name)).size !== archives.length) throw Error('Duplicate backup name.');
  const sorted = [...archives].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.name.localeCompare(a.name));
  const keep = new Map<string, string>(), days = new Set<string>(), weeks = new Set<string>();
  for (const archive of sorted) {
    const day = retentionDay(archive.createdAt);
    if (!days.has(day) && days.size < 7) {
      days.add(day); weeks.add(week(day)); keep.set(archive.name, 'daily');
    }
  }
  let weekly = 0;
  for (const archive of sorted) {
    const bucket = week(retentionDay(archive.createdAt));
    if (!weeks.has(bucket) && weekly < 4) {
      weeks.add(bucket); weekly++; keep.set(archive.name, 'weekly');
    }
  }
  return sorted.map(archive => ({ ...archive, action: keep.has(archive.name) ? 'keep' as const : 'review-removal' as const,
    reason: keep.get(archive.name) ?? 'Outside daily/weekly recovery points' }));
}

export function createRetentionPreview(directory = path.resolve('.folio-backups')) {
  const root = realpathSync(directory);
  const encoded = process.env.FOLIO_BACKUP_KEY?.trim() ?? readFileSync('.folio-backup-key', 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw Error('Original recovery key is required.');
  const key = Buffer.from(encoded, 'base64');
  const archives: RetentionArchive[] = [], protectedFiles: {name:string;reason:string}[] = [];
  for (const name of readdirSync(root).filter(name => name.endsWith('.foliobackup'))) {
    const full = path.join(root, name), stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(realpathSync(full)) !== root ||
        !/^folio-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{6}\.foliobackup$/.test(name)) {
      protectedFiles.push({name, reason:'Manual/reference/download copy or nonstandard path; keep'}); continue;
    }
    if (stat.size > 130 * 1024 * 1024) { protectedFiles.push({name, reason:'Outside portable archive size; keep'}); continue; }
    try {
      const data = readFileSync(full), snapshot = open(data, key);
      retentionDay(snapshot.createdAt);
      if (Date.parse(snapshot.createdAt) > Date.now() + 300_000) throw Error('Future timestamp');
      const report = JSON.parse(readFileSync(full + '.verified.json', 'utf8'));
      if (report.isolation !== 'in-memory PGlite; no production restore' || !Number.isFinite(Date.parse(report.verifiedAt))) throw Error('Missing verification');
      archives.push({name, createdAt:snapshot.createdAt, bytes:data.length, sha256:createHash('sha256').update(data).digest('hex')});
    } catch { protectedFiles.push({name, reason:'Unreadable, unverified, future-dated or failed integrity check; keep for investigation'}); }
  }
  const rows = planRetention(archives);
  return {version:1, generatedAt:new Date().toISOString(), timeZone:'America/Toronto', directory:root,
    policy:'Newest archive on each of seven most recent available backup dates; newest archive in four additional older Monday-start weeks not represented by daily copies. Gaps do not expire the latest backup.',
    rows, protectedFiles,
    summary:{keep:rows.filter(row=>row.action==='keep').length, reviewRemoval:rows.filter(row=>row.action==='review-removal').length,
      protected:protectedFiles.length, reclaimableBytes:rows.filter(row=>row.action==='review-removal').reduce((sum,row)=>sum+row.bytes,0)},
    scope:'Local preview only. No deletion, R2 listing, upload, schedule or lifecycle change. Integrity checked now; prior restore reports are not fresh restore tests.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw Error('Preview accepts no flags; cleanup requires separate review.');
    const preview = createRetentionPreview();
    const output = path.join(preview.directory, 'retention-preview.json');
    writeFileSync(output, JSON.stringify(preview,null,2)+'\n', {mode:0o600});
    console.table(preview.rows.map(({name,action,reason})=>({name,action,reason})));
    console.log(JSON.stringify(preview.summary));
    console.log(`Protected special/reference files: ${preview.protectedFiles.length}. Preview: ${output}`);
    console.log(preview.scope);
  } catch { console.error('Retention preview stopped. Check the original key and backup directory; nothing was deleted.'); process.exitCode=1; }
}
