import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from './logger';

// ============================================================
// Warmup (cuota 24 h) + cadencia regular por usuario
// Patrón: Alertas VIP Inmobiliarias — ver README § Digests
// Redis keys por usuario; fallback Map si Redis cae (single-process)
// ============================================================

const WARMUP_KEY_PREFIX = 'digest:warmup:';
const WARMUP_QUOTA_KEY_PREFIX = 'digest:warmup_quota:';
const COOLDOWN_KEY_PREFIX = 'digest:cooldown:';
const CADENCE_KEY_PREFIX = 'digest:next_regular:';

const warmupMemory = new Map<string, number>();
const warmupQuotaMemory = new Map<string, number>();
const cooldownMemory = new Map<string, number>();
const cadenceMemory = new Map<string, number>();

function redis() {
  return isRedisAvailable() ? getRedis() : null;
}

function warmupKey(id: string) {
  return `${WARMUP_KEY_PREFIX}${id}`;
}
function warmupQuotaKey(id: string) {
  return `${WARMUP_QUOTA_KEY_PREFIX}${id}`;
}
function cooldownKey(id: string) {
  return `${COOLDOWN_KEY_PREFIX}${id}`;
}
function cadenceKey(id: string) {
  return `${CADENCE_KEY_PREFIX}${id}`;
}

function warmupQuotaHours(): number {
  return Math.max(1, parseInt(process.env['DIGEST_WARMUP_QUOTA_HOURS'] ?? '24', 10));
}

function warmupMinMinutes(): number {
  return Math.max(1, parseInt(process.env['DIGEST_WARMUP_MIN_MINUTES'] ?? '5', 10));
}

function warmupMaxMinutes(): number {
  return Math.max(warmupMinMinutes(), parseInt(process.env['DIGEST_WARMUP_MAX_MINUTES'] ?? '15', 10));
}

/** Cadencia regular por VIP (default 120 min = 2 h). */
export function notifierIntervalMs(): number {
  const mins = Math.max(1, parseInt(process.env['NOTIFIER_INTERVAL_MINUTES'] ?? '120', 10));
  return mins * 60 * 1000;
}

export type DigestWarmupScheduleResult =
  | { ok: true; delayMinutes: number }
  | { ok: false; reason: 'pending' }
  | { ok: false; reason: 'quota'; retryAfterSec: number };

async function getWarmupQuotaRetryAfterSec(telegramId: string): Promise<number | null> {
  const memUntil = warmupQuotaMemory.get(telegramId);
  if (memUntil !== undefined) {
    if (memUntil > Date.now()) {
      return Math.max(1, Math.ceil((memUntil - Date.now()) / 1000));
    }
    warmupQuotaMemory.delete(telegramId);
  }

  const r = redis();
  if (!r) return null;
  const ttl = await r.ttl(warmupQuotaKey(telegramId));
  if (ttl > 0) return ttl;
  return null;
}

async function markWarmupQuota(telegramId: string): Promise<void> {
  const ttlSec = warmupQuotaHours() * 3600;
  warmupQuotaMemory.set(telegramId, Date.now() + ttlSec * 1000);
  const r = redis();
  if (!r) return;
  await r.set(warmupQuotaKey(telegramId), '1', 'EX', ttlSec);
}

/** dueAt: ahora+delay si cae en ventana del usuario; si no, próximo start de su /horario. */
async function calcularDueWarmup(telegramId: string, delayMin: number): Promise<number> {
  const { loadDigestPrefs, calcularDueWarmupEnVentana } = await import('./digest-schedule.service');
  const prefs = await loadDigestPrefs(telegramId);
  return calcularDueWarmupEnVentana(prefs, delayMin);
}

/**
 * Encola primer digest 5–15 min (cuota 1× / DIGEST_WARMUP_QUOTA_HOURS).
 * pending = ya en cola; quota = ya usó el envío rápido.
 */
export async function scheduleDigestWarmup(telegramId: string): Promise<DigestWarmupScheduleResult> {
  const r = redis();

  if (!r) {
    if (warmupMemory.has(telegramId)) return { ok: false, reason: 'pending' };
  } else {
    const existing = await r.get(warmupKey(telegramId));
    if (existing) return { ok: false, reason: 'pending' };
  }

  const retryAfterSec = await getWarmupQuotaRetryAfterSec(telegramId);
  if (retryAfterSec !== null) {
    return { ok: false, reason: 'quota', retryAfterSec };
  }

  const delayMin =
    warmupMinMinutes() +
    Math.floor(Math.random() * (warmupMaxMinutes() - warmupMinMinutes() + 1));
  const dueAt = await calcularDueWarmup(telegramId, delayMin);
  const delayUntilMin = Math.max(1, Math.ceil((dueAt - Date.now()) / 60_000));
  const ttlSec = Math.ceil((dueAt - Date.now()) / 1000) + 3600;

  if (!r) {
    warmupMemory.set(telegramId, dueAt);
    logger.info(`⏱ Warmup digest ${telegramId}: en ~${delayUntilMin} min (mem)`);
    return { ok: true, delayMinutes: delayUntilMin };
  }

  const ok = await r.set(warmupKey(telegramId), String(dueAt), 'EX', Math.max(ttlSec, 3600), 'NX');
  if (ok !== 'OK') return { ok: false, reason: 'pending' };

  // Cuota se marca solo tras envío OK (markWarmupDigestSent) — no quemar si cola vacía / Telegram falla
  logger.info(`⏱ Warmup digest ${telegramId}: en ~${delayUntilMin} min`);
  return { ok: true, delayMinutes: delayUntilMin };
}

/** Warmups cuyo dueAt ya pasó (no borra; el worker debe clearDigestWarmup). */
export async function listDueDigestWarmups(now = Date.now()): Promise<string[]> {
  const due: string[] = [];
  const r = redis();

  if (!r) {
    for (const [id, dueAt] of warmupMemory) {
      if (dueAt <= now) due.push(id);
    }
    return due;
  }

  let cursor = '0';
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', `${WARMUP_KEY_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const raw = await r.get(key);
      if (!raw) continue;
      const dueAt = parseInt(raw, 10);
      if (!Number.isFinite(dueAt) || dueAt > now) continue;
      due.push(key.slice(WARMUP_KEY_PREFIX.length));
    }
  } while (cursor !== '0');

  for (const [id, dueAt] of warmupMemory) {
    if (dueAt <= now && !due.includes(id)) due.push(id);
  }
  return due;
}

/** @deprecated Prefer listDue + clear; kept for callers that claim atomically. */
export async function claimDueWarmups(now = Date.now()): Promise<string[]> {
  const due = await listDueDigestWarmups(now);
  for (const id of due) {
    await clearDigestWarmup(id);
  }
  return due;
}

export async function clearDigestWarmup(telegramId: string): Promise<void> {
  warmupMemory.delete(telegramId);
  const r = redis();
  if (r) await r.del(warmupKey(telegramId));
}

/** Reprograma dueAt sin tocar cuota (p. ej. fuera de ventana /horario). */
export async function rescheduleDigestWarmupAt(telegramId: string, dueAtMs: number): Promise<void> {
  const ttlSec = Math.max(3600, Math.ceil((dueAtMs - Date.now()) / 1000) + 3600);
  warmupMemory.set(telegramId, dueAtMs);
  const r = redis();
  if (r) await r.set(warmupKey(telegramId), String(dueAtMs), 'EX', ttlSec);
}

/** Alias reset radar. */
export async function cancelDigestWarmup(telegramId: string): Promise<void> {
  await clearDigestWarmup(telegramId);
}

export async function markDigestCooldown(telegramId: string, ttlSec = 90): Promise<void> {
  cooldownMemory.set(telegramId, Date.now() + ttlSec * 1000);
  const r = redis();
  if (r) await r.set(cooldownKey(telegramId), '1', 'EX', ttlSec);
}

export async function hasDigestCooldown(telegramId: string): Promise<boolean> {
  const mem = cooldownMemory.get(telegramId);
  if (mem && mem > Date.now()) return true;
  if (mem && mem <= Date.now()) cooldownMemory.delete(telegramId);

  const r = redis();
  if (!r) return false;
  return !!(await r.get(cooldownKey(telegramId)));
}

export async function clearDigestCooldown(telegramId: string): Promise<void> {
  cooldownMemory.delete(telegramId);
  const r = redis();
  if (r) await r.del(cooldownKey(telegramId));
}

async function setNextRegularAt(telegramId: string, nextAtMs: number): Promise<void> {
  cadenceMemory.set(telegramId, nextAtMs);
  const r = redis();
  if (!r) return;
  const ttlSec = Math.ceil((nextAtMs - Date.now()) / 1000) + 7 * 24 * 3600;
  await r.set(cadenceKey(telegramId), String(nextAtMs), 'EX', Math.max(ttlSec, 3600));
}

async function getNextRegularAt(telegramId: string): Promise<number | null> {
  const mem = cadenceMemory.get(telegramId);
  if (mem !== undefined) return mem;

  const r = redis();
  if (!r) return null;
  const raw = await r.get(cadenceKey(telegramId));
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  cadenceMemory.set(telegramId, n);
  return n;
}

export async function getNextRegularAtMs(telegramId: string): Promise<number | null> {
  return getNextRegularAt(telegramId);
}

export async function setNextRegularAtMs(telegramId: string, nextAtMs: number): Promise<void> {
  await setNextRegularAt(telegramId, nextAtMs);
}

async function intervalMsForUser(telegramId: string): Promise<number> {
  try {
    const { loadDigestPrefs, intervalMsFromPrefs } = await import('./digest-schedule.service');
    return intervalMsFromPrefs(await loadDigestPrefs(telegramId));
  } catch {
    return notifierIntervalMs();
  }
}

/** Tras Listo filtros: next_regular = now + intervalo del usuario; limpia debounce. Devuelve minutos. */
export async function resetDigestCadenceOnFilterApply(telegramId: string): Promise<number> {
  const interval = await intervalMsForUser(telegramId);
  await setNextRegularAt(telegramId, Date.now() + interval);
  await clearDigestCooldown(telegramId);
  return Math.ceil(interval / 60_000);
}

/** Sin clave = due (primera vez / legacy). */
export async function isRegularDigestDue(telegramId: string): Promise<boolean> {
  const next = await getNextRegularAt(telegramId);
  if (next === null) return true;
  return Date.now() >= next;
}

/** Tras digest regular enviado → avanza reloj (intervalo del /horario) + debounce. */
export async function markRegularDigestSent(telegramId: string): Promise<void> {
  const interval = await intervalMsForUser(telegramId);
  await setNextRegularAt(telegramId, Date.now() + interval);
  await markDigestCooldown(telegramId, 90);
}

/** Tras warmup: NO mueve next_regular; marca cuota 24 h + debounce. */
export async function markWarmupDigestSent(telegramId: string): Promise<void> {
  await markWarmupQuota(telegramId);
  await markDigestCooldown(telegramId, 90);
}
