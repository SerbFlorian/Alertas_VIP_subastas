import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { logger } from './logger';

export interface R2BackupObject {
  key: string;
  size: number;
  lastModified: Date;
}

// ============================================================
// Cloudflare R2 (S3-compatible) — backups offsite
// ============================================================

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta ${name} en .env`);
  return v;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env['R2_ACCESS_KEY_ID']?.trim() &&
      process.env['R2_SECRET_ACCESS_KEY']?.trim() &&
      process.env['R2_BUCKET']?.trim() &&
      (process.env['R2_ENDPOINT']?.trim() || process.env['R2_ACCOUNT_ID']?.trim())
  );
}

export function getR2Client(): S3Client {
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const accountId = process.env['R2_ACCOUNT_ID']?.trim();
  const endpoint =
    process.env['R2_ENDPOINT']?.trim() ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  if (!endpoint) throw new Error('Falta R2_ENDPOINT o R2_ACCOUNT_ID');

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export function getR2Bucket(): string {
  return requireEnv('R2_BUCKET');
}

export async function uploadBackupToR2(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  logger.info(`☁️ R2 upload OK: s3://${bucket}/${key} (${body.length} bytes)`);
}

/**
 * Lista backups bajo prefix, más recientes primero.
 */
export async function listR2Backups(prefix: string): Promise<R2BackupObject[]> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  const items: R2BackupObject[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;
      items.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return items;
}

export async function getLatestBackupKey(prefix: string): Promise<string> {
  const items = await listR2Backups(prefix);
  const latest = items[0];
  if (!latest) {
    throw new Error(`No hay backups en R2 bajo prefix "${prefix}"`);
  }
  return latest.key;
}

export async function downloadR2Object(key: string): Promise<Buffer> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes || bytes.length === 0) {
    throw new Error(`R2 objeto vacío o ilegible: s3://${bucket}/${key}`);
  }
  const buf = Buffer.from(bytes);
  logger.info(`☁️ R2 download OK: s3://${bucket}/${key} (${buf.length} bytes)`);
  return buf;
}

/**
 * Borra objetos bajo prefix más antiguos que retentionDays (por LastModified).
 */
export async function pruneR2Backups(prefix: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const client = getR2Client();
  const bucket = getR2Bucket();
  const cutoff = Date.now() - retentionDays * 24 * 3600_000;
  const toDelete: { Key: string }[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified.getTime() < cutoff) {
        toDelete.push({ Key: obj.Key });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  if (!toDelete.length) return 0;

  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk, Quiet: true },
      })
    );
  }

  logger.info(`🧹 R2 retención: eliminados ${toDelete.length} backup(s) > ${retentionDays}d`);
  return toDelete.length;
}
