import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from './logger';

// ============================================================
// Notification queue — Redis LIST with in-memory fallback
// Digest = up to 3 auction lots packed in one Telegram message
// ============================================================

export interface DigestLot {
  id_subasta: string;
  id_lote: string;
  portal: string;
  titulo: string;
  marca: string;
  modelo: string;
  puja_minima: number;
  enlace: string;
  comunidad_autonoma?: string | null;
  fecha_fin?: string | null;
  urgente?: boolean;
}

export interface DigestPayload {
  telegramId: string;
  lots: DigestLot[];
  createdAt: string;
  urgent?: boolean;
}

const memoryQueues = new Map<string, DigestPayload[]>();

function queueKey(telegramId: string): string {
  return `notif:q:${telegramId}`;
}

function maxPending(): number {
  return parseInt(process.env['NOTIF_MAX_PENDING_PER_USER'] ?? '3', 10);
}

function maxLotsPerDigest(): number {
  return 3;
}

export function lotKey(lot: Pick<DigestLot, 'portal' | 'id_subasta' | 'id_lote'>): string {
  return `${lot.portal}|${lot.id_subasta}|${lot.id_lote}`;
}

function uniqueLots(lots: DigestLot[]): DigestLot[] {
  const seen = new Set<string>();
  const out: DigestLot[] = [];
  for (const lot of lots) {
    const k = lotKey(lot);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(lot);
  }
  return out;
}

async function listQueuedDigests(telegramId: string): Promise<DigestPayload[]> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.lrange(queueKey(telegramId), 0, -1);
      return raw.map((r) => JSON.parse(r) as DigestPayload);
    } catch (error) {
      logger.warn(`⚠️ listQueuedDigests Redis: ${(error as Error).message}`);
    }
  }
  return [...(memoryQueues.get(telegramId) ?? [])];
}

/** Lotes ya pendientes en cola (aún no enviados). */
export async function queuedLotKeys(telegramId: string): Promise<Set<string>> {
  const digests = await listQueuedDigests(telegramId);
  const keys = new Set<string>();
  for (const d of digests) {
    for (const lot of d.lots) keys.add(lotKey(lot));
  }
  return keys;
}

export function packLotsIntoDigests(telegramId: string, lots: DigestLot[]): DigestPayload[] {
  const digests: DigestPayload[] = [];
  const chunk = maxLotsPerDigest();
  const clean = uniqueLots(lots);
  for (let i = 0; i < clean.length; i += chunk) {
    const slice = clean.slice(i, i + chunk);
    digests.push({
      telegramId,
      lots: slice,
      createdAt: new Date().toISOString(),
      urgent: slice.some((l) => l.urgente),
    });
  }
  return digests;
}

export async function enqueueDigests(telegramId: string, lots: DigestLot[]): Promise<number> {
  if (!lots.length) return 0;

  // No reencolar lotes que ya esperan en Redis/memoria (matching corre cada pocos min)
  const pending = await queuedLotKeys(telegramId);
  const fresh = uniqueLots(lots).filter((l) => !pending.has(lotKey(l)));
  if (!fresh.length) return 0;

  const digests = packLotsIntoDigests(telegramId, fresh);
  const key = queueKey(telegramId);
  const limit = maxPending();

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const pipe = redis.pipeline();
      for (const d of digests) {
        pipe.rpush(key, JSON.stringify(d));
      }
      pipe.ltrim(key, -limit, -1);
      await pipe.exec();
      return digests.length;
    } catch (error) {
      logger.warn(`⚠️ enqueue Redis falló, memoria: ${(error as Error).message}`);
    }
  }

  const existing = memoryQueues.get(telegramId) ?? [];
  existing.push(...digests);
  memoryQueues.set(telegramId, existing.slice(-limit));
  return digests.length;
}

export async function clearUserQueue(telegramId: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.del(queueKey(telegramId));
    } catch (error) {
      logger.warn(`⚠️ clearUserQueue Redis: ${(error as Error).message}`);
    }
  }
  memoryQueues.delete(telegramId);
}

export async function popUserDigests(telegramId: string, maxMessages: number): Promise<DigestPayload[]> {
  const out: DigestPayload[] = [];
  const redis = getRedis();

  if (redis && isRedisAvailable()) {
    try {
      for (let i = 0; i < maxMessages; i++) {
        const raw = await redis.lpop(queueKey(telegramId));
        if (!raw) break;
        out.push(JSON.parse(raw) as DigestPayload);
      }
      return out;
    } catch (error) {
      logger.warn(`⚠️ popUserDigests Redis: ${(error as Error).message}`);
    }
  }

  const mem = memoryQueues.get(telegramId) ?? [];
  const taken = mem.splice(0, maxMessages);
  memoryQueues.set(telegramId, mem);
  return taken;
}

export async function listQueuedUserIds(): Promise<string[]> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const keys = await redis.keys('notif:q:*');
      return keys.map((k) => k.replace('notif:q:', ''));
    } catch (error) {
      logger.warn(`⚠️ listQueuedUserIds Redis: ${(error as Error).message}`);
    }
  }
  return Array.from(memoryQueues.keys()).filter((id) => (memoryQueues.get(id)?.length ?? 0) > 0);
}

export async function peekQueueLength(telegramId: string): Promise<number> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      return await redis.llen(queueKey(telegramId));
    } catch {
      /* fallthrough */
    }
  }
  return memoryQueues.get(telegramId)?.length ?? 0;
}

/** Reencola al frente si Telegram falló (evita perder el digest tras LPOP). */
export async function requeueDigestFront(payload: DigestPayload): Promise<void> {
  const key = queueKey(payload.telegramId);
  const limit = maxPending();
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.lpush(key, JSON.stringify(payload));
      await redis.ltrim(key, 0, limit - 1);
      return;
    } catch (error) {
      logger.warn(`⚠️ requeueDigestFront Redis: ${(error as Error).message}`);
    }
  }
  const existing = memoryQueues.get(payload.telegramId) ?? [];
  existing.unshift(payload);
  memoryQueues.set(payload.telegramId, existing.slice(0, limit));
}
