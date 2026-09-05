import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import path from 'path';
import { isR2Configured, uploadBackupToR2, pruneR2Backups } from '../services/r2.service';
import { sendCriticalAlert } from '../services/alert.service';
import { logger } from '../services/logger';

// ============================================================
// Backup → pg_dump | gzip → Cloudflare R2
// Telegram: solo CRITICAL si falla (nunca el dump)
// ============================================================

const PREFIX = 'pg-dumps/';

function parseDatabaseUrl(raw: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '').split('?')[0] || 'postgres',
  };
}

/**
 * Ejecuta pg_dump y comprime en Node (sin bash pipe).
 * Antes: `pg_dump | gzip > file` sin pipefail → gzip vacío ~20B y exit 0
 * aunque pg_dump fallara (host, auth o binario ausente).
 */
async function runPgDumpToGzip(outPath: string): Promise<void> {
  const raw = process.env['DATABASE_URL'];
  if (!raw) throw new Error('DATABASE_URL no configurada');

  const db = parseDatabaseUrl(raw);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  logger.info(`📦 pg_dump host=${db.host}:${db.port} db=${db.database} user=${db.user}`);

  const dump = spawn(
    'pg_dump',
    [
      '-h',
      db.host,
      '-p',
      db.port,
      '-U',
      db.user,
      '-d',
      db.database,
      '--no-owner',
      '--no-acl',
      '-F',
      'p',
    ],
    {
      env: { ...process.env, PGPASSWORD: db.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stderr = '';
  dump.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
  });

  const exitCode = new Promise<number>((resolve, reject) => {
    dump.on('error', (err) => {
      reject(
        new Error(
          `No se pudo ejecutar pg_dump (${err.message}). ¿postgresql-client en la imagen?`
        )
      );
    });
    dump.on('close', (code) => resolve(code ?? 1));
  });

  try {
    await pipeline(dump.stdout!, createGzip({ level: 9 }), createWriteStream(outPath));
  } catch (err) {
    const code = await exitCode.catch(() => -1);
    throw new Error(
      `Fallo al escribir dump (pg_dump exit ${code}): ${(err as Error).message}\n${stderr.slice(0, 800)}`
    );
  }

  const code = await exitCode;
  if (code !== 0) {
    throw new Error(`pg_dump exit ${code}: ${stderr.slice(0, 800) || '(sin stderr)'}`);
  }
}

export async function ejecutarBackupJob(): Promise<void> {
  logger.info('📦 Backup R2: inicio');

  if (!isR2Configured()) {
    const msg = 'Backup CRITICAL: R2 no configurado (R2_ACCESS_KEY_ID / SECRET / BUCKET / ENDPOINT)';
    logger.error(`❌ ${msg}`);
    await sendCriticalAlert(msg);
    return;
  }

  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${PREFIX}backup-${iso}.sql.gz`;
  const tempDir = path.join(process.cwd(), 'temp');
  const localPath = path.join(tempDir, `backup-${iso}.sql.gz`);
  const retention = Math.max(1, parseInt(process.env['BACKUP_RETENTION_DAYS'] ?? '7', 10));

  try {
    await runPgDumpToGzip(localPath);
    const stat = await fs.stat(localPath);
    if (stat.size < 64) {
      throw new Error(
        `Dump demasiado pequeño (${stat.size} bytes). Revisa conectividad a Postgres desde el contenedor.`
      );
    }

    const body = await fs.readFile(localPath);
    await uploadBackupToR2(key, body, 'application/gzip');

    const pruned = await pruneR2Backups(PREFIX, retention);
    logger.info(
      `✅ Backup R2 OK · key=${key} · size=${(body.length / 1024).toFixed(1)}KB · pruned=${pruned}`
    );
  } catch (error) {
    const err = error as Error;
    logger.error('❌ Backup R2 falló:', { error: err.message });
    await sendCriticalAlert(
      `BACKUP R2 FALLÓ\n${err.message}\nEl dump NO se envía a Telegram. Revisa pg_dump / credenciales R2.`
    );
    throw error;
  } finally {
    try {
      await fs.unlink(localPath);
    } catch {
      /* ignore */
    }
  }
}

if (require.main === module) {
  import('dotenv/config').then(() =>
    ejecutarBackupJob()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  );
}
