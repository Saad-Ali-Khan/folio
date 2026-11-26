import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

export const BACKUP_R2_LIMITS = Object.freeze({ bytes: 1_000_000_000, objects: 100, fileBytes: 130 * 1024 * 1024 });
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export type BackupTransport = (method: string, suffix: string, data?: Buffer) => Promise<Response>;

async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Backup R2 returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const row = await reader.read(); if (row.done) break;
      size += row.value.length;
      if (size > limit) throw Error('Backup R2 response exceeds the safety limit.');
      chunks.push(row.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

// Only encrypted, locally restore-verified archives reach this function.
// No delete API: reaching a limit requires an explicit retention review.
export async function uploadEncryptedBackup(data: Buffer, request: BackupTransport) {
  if (!data.length || data.length > BACKUP_R2_LIMITS.fileBytes) throw Error('Backup R2 archive size limit exceeded.');
  const hash = digest(data), key = `archives/${hash}.foliobackup`;
  const listing = await request('GET', '?list-type=2&max-keys=1000&encoding-type=url');
  const xml = (await boundedBody(listing, 1_000_000)).toString('utf8');
  if (!/<ListBucketResult(?:\s|>)/.test(xml) || !/<IsTruncated>false<\/IsTruncated>/.test(xml)) throw Error('Backup R2 listing incomplete; upload stopped.');
  const entries = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(row => {
    const size = /<Size>(\d+)<\/Size>/.exec(row[1]), name = /<Key>([^<]+)<\/Key>/.exec(row[1]);
    if (!size || !name || !Number.isSafeInteger(Number(size[1]))) throw Error('Backup R2 listing invalid.');
    return { key: decodeURIComponent(name[1]), bytes: Number(size[1]) };
  });
  const used = entries.reduce((total, row) => total + row.bytes, 0);
  if (!Number.isSafeInteger(used)) throw Error('Backup R2 listing size invalid.');
  const existing = entries.find(row => row.key === key);
  if (!existing) {
    if (entries.length >= BACKUP_R2_LIMITS.objects || used + data.length > BACKUP_R2_LIMITS.bytes) throw Error('Backup R2 storage/count limit reached. Local archive retained; review retention before uploading more.');
    const result = await request('PUT', key, data); await result.body?.cancel();
  }
  const downloaded = await boundedBody(await request('GET', key), BACKUP_R2_LIMITS.fileBytes);
  if (downloaded.length !== data.length || digest(downloaded) !== hash) throw Error('Backup R2 downloaded checksum differs. Local archive retained.');
  return { key, sha256: hash, bytes: data.length, bucketBytes: used + (existing ? 0 : data.length), alreadyPresent: Boolean(existing), downloaded };
}

export function backupTransport(reserveRequest: () => void): BackupTransport {
  const account = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID?.trim(), secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY?.trim();
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !accessKeyId || !secretAccessKey) throw Error('Backup R2 needs R2_ACCOUNT_ID and separate R2_BACKUP_ACCESS_KEY_ID/R2_BACKUP_SECRET_ACCESS_KEY scoped to folio-backups.');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  return async (method, suffix, data) => {
    if (!(method === 'GET' && suffix === '?list-type=2&max-keys=1000&encoding-type=url') &&
        !(['GET', 'PUT'].includes(method) && /^archives\/[a-f0-9]{64}\.foliobackup$/.test(suffix))) throw Error('Backup R2 request refused.');
    reserveRequest();
    const signed = await client.sign(`https://${account}.r2.cloudflarestorage.com/folio-backups/${suffix}`, {
      method, headers: data ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length), 'x-amz-storage-class': 'STANDARD', 'If-None-Match': '*' } : {},
      body: data ? new Uint8Array(data) : undefined,
    });
    const response = await fetch(signed, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Backup R2 ${method} failed (HTTP ${response.status}). Local archive retained.`); }
    return response;
  };
}
