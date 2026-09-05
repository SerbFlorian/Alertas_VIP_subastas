import 'dotenv/config';
import axios from 'axios';
import { prisma } from '../db/prisma';
import { initRedis, disconnectRedis, isRedisAvailable } from '../db/redis';
import { logger, redactSecrets } from '../services/logger';

// ============================================================
// verify:system — humo post-deploy (sin filtrar secretos)
// ============================================================

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_PUBLICO_ID',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function notifyAdmin(html: string): Promise<void> {
  const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  const chat = (process.env['TELEGRAM_ADMIN_CHAT_ID'] ?? '').trim();
  if (!token || !chat) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chat,
        text: redactSecrets(html).slice(0, 3500),
        parse_mode: 'HTML',
        disable_notification: true,
      },
      { timeout: 10_000 }
    );
  } catch (e) {
    logger.warn(`verify notify falló: ${(e as Error).message}`);
  }
}

async function checkEnv(): Promise<CheckResult> {
  const missing = REQUIRED.filter((k) => !(process.env[k] ?? '').trim());
  return {
    name: 'env',
    ok: missing.length === 0,
    detail: missing.length ? `faltan: ${missing.join(',')}` : 'ok',
  };
}

async function checkPostgres(): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: 'postgres', ok: true, detail: 'ok' };
  } catch (e) {
    return { name: 'postgres', ok: false, detail: (e as Error).message };
  }
}

async function checkRedis(): Promise<CheckResult> {
  await initRedis();
  return {
    name: 'redis',
    ok: isRedisAvailable(),
    detail: isRedisAvailable() ? 'ok' : 'unavailable',
  };
}

async function checkHealthHttp(): Promise<CheckResult> {
  const port = process.env['PORT'] ?? '3002';
  const url = process.env['VERIFY_HEALTH_URL'] ?? `http://127.0.0.1:${port}/health`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const body = (await res.json()) as { status?: string };
    const ok = res.ok && body.status === 'ok';
    return { name: 'health', ok, detail: ok ? 'ok' : `status=${res.status}` };
  } catch (e) {
    return { name: 'health', ok: false, detail: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const skipHttp = (process.env['VERIFY_SKIP_HTTP'] ?? '').toLowerCase() === 'true';
  const results: CheckResult[] = [];

  results.push(await checkEnv());
  results.push(await checkPostgres());
  results.push(await checkRedis());
  if (!skipHttp) results.push(await checkHealthHttp());

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    logger.info(`${r.ok ? '✅' : '❌'} verify:${r.name} — ${r.detail ?? ''}`);
  }

  if (failed.length) {
    const summary = failed.map((f) => `${f.name}:${f.detail}`).join('; ');
    await notifyAdmin(`🚨 <b>verify:system FAIL</b>\n<code>${redactSecrets(summary)}</code>`);
    await disconnectRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  logger.info('✅ verify:system OK');
  if ((process.env['VERIFY_NOTIFY_OK'] ?? 'true').toLowerCase() !== 'false') {
    const when = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    await notifyAdmin(`✅ <b>verify:system OK</b>\n<code>${when}</code>`);
  }

  await disconnectRedis().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  logger.error('verify:system crash', { error: (e as Error).message });
  await notifyAdmin(`🚨 <b>verify:system crash</b>\n<code>${redactSecrets((e as Error).message)}</code>`);
  process.exit(1);
});
