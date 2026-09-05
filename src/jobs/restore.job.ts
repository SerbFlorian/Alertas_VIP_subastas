import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import path from 'path';
import {
  isR2Configured,
  downloadR2Object,
  getLatestBackupKey,
} from '../services/r2.service';
import { sendCriticalAlert } from '../services/alert.service';
import { logger } from '../services/logger';

// ============================================================
// Restore ← R2 pg-dumps/*.sql.gz → DROP SCHEMA + psql
// Requiere CONFIRM_RESTORE=YES (destructivo)
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

function runPsql(
  db: ReturnType<typeof parseDatabaseUrl>,
  args: string[],
  input?: NodeJS.ReadableStream
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      [
        '-h',
        db.host,
        '-p',
        db.port,
        '-U',
        db.user,
        '-d',
        db.database,
        '-v',
        'ON_ERROR_STOP=1',
        ...args,
      ],
      {
        env: { ...process.env, PGPASSWORD: db.password },
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }
    );

    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`No se pudo ejecutar psql (${err.message}). ¿postgresql-client-16?`));
    });

    if (input && child.stdin) {
      input.pipe(child.stdin);
      input.on('error', reject);
    }

    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `psql exit ${code}: ${(stderr || stdout).slice(0, 1200) || '(sin salida)'}`
          )
        );
      }
    });
  });
}

async function resetPublicSchema(db: ReturnType<typeof parseDatabaseUrl>): Promise<void> {
  const sql = [
    'DROP SCHEMA IF EXISTS public CASCADE;',
    'CREATE SCHEMA public;',
    'GRANT ALL ON SCHEMA public TO postgres;',
    'GRANT ALL ON SCHEMA public TO public;',
  ].join(' ');
  await runPsql(db, ['-c', sql]);
  logger.info('🧹 Schema public reseteado (DROP CASCADE + CREATE)');
}

async function restoreSqlGz(db: ReturnType<typeof parseDatabaseUrl>, gzPath: string): Promise<void> {
  const gunzip = createGunzip();
  const source = createReadStream(gzPath);
  // Pipe gunzip → psql stdin without buffering whole SQL in memory
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'psql',
      [
        '-h',
        db.host,
        '-p',
        db.port,
        '-U',
        db.user,
        '-d',
        db.database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        env: { ...process.env, PGPASSWORD: db.password },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);

    pipeline(source, gunzip, child.stdin!)
      .catch((err) => {
        // EPIPE if psql exits early — wait for exit code
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          reject(err);
        }
      });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql restore exit ${code}: ${stderr.slice(0, 1200) || '(sin stderr)'}`));
    });
  });
}

export async function ejecutarRestoreJob(): Promise<void> {
  logger.info('♻️ Restore R2: inicio');

  if (process.env['CONFIRM_RESTORE']?.trim() !== 'YES') {
    throw new Error(
      'Restore abortado: define CONFIRM_RESTORE=YES (borra TODOS los datos actuales de la BD).'
    );
  }

  if (!isR2Configured()) {
    throw new Error('R2 no configurado (R2_ACCESS_KEY_ID / SECRET / BUCKET / ENDPOINT)');
  }

  const raw = process.env['DATABASE_URL'];
  if (!raw) throw new Error('DATABASE_URL no configurada');
  const db = parseDatabaseUrl(raw);

  let key = process.env['RESTORE_KEY']?.trim() || '';
  const tempDir = path.join(process.cwd(), 'temp');
  let localPath = '';

  try {
    if (!key) key = await getLatestBackupKey(PREFIX);
    localPath = path.join(tempDir, path.basename(key));
    await fs.mkdir(tempDir, { recursive: true });

    logger.info(`♻️ Restore key=${key} → ${db.host}:${db.port}/${db.database}`);
    const body = await downloadR2Object(key);
    if (body.length < 64) {
      throw new Error(`Backup demasiado pequeño (${body.length} bytes)`);
    }
    await fs.writeFile(localPath, body);
    logger.info(`💾 Dump local ${(body.length / 1024).toFixed(1)}KB → ${localPath}`);

    await resetPublicSchema(db);
    await restoreSqlGz(db, localPath);

    logger.info(`✅ Restore R2 OK · key=${key} · size=${(body.length / 1024).toFixed(1)}KB`);
  } catch (error) {
    const err = error as Error;
    logger.error('❌ Restore R2 falló:', { error: err.message });
    await sendCriticalAlert(
      `RESTORE R2 FALLÓ\nkey=${key || '(sin key)'}\n${err.message}\nEl dump NO se envía a Telegram.`
    );
    throw error;
  } finally {
    if (localPath) {
      try {
        await fs.unlink(localPath);
      } catch {
        /* ignore */
      }
    }
  }
}

if (require.main === module) {
  import('dotenv/config').then(() =>
    ejecutarRestoreJob()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  );
}
