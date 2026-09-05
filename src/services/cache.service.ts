import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from './logger';

// ============================================================
// Lightweight Redis JSON cache with memory fallback
// ============================================================

const memory = new Map<string, { value: string; expiresAt: number }>();

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch (error) {
      logger.warn(`⚠️ cacheGet ${key}: ${(error as Error).message}`);
    }
  }

  const hit = memory.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return JSON.parse(hit.value) as T;
  }
  if (hit) memory.delete(key);
  return null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const raw = JSON.stringify(value);
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(key, raw, 'EX', ttlSeconds);
      return;
    } catch (error) {
      logger.warn(`⚠️ cacheSet ${key}: ${(error as Error).message}`);
    }
  }
  memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheDel(patternOrKey: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      if (patternOrKey.includes('*')) {
        const keys = await redis.keys(patternOrKey);
        if (keys.length) await redis.del(...keys);
      } else {
        await redis.del(patternOrKey);
      }
    } catch (error) {
      logger.warn(`⚠️ cacheDel ${patternOrKey}: ${(error as Error).message}`);
    }
  }

  if (patternOrKey.includes('*')) {
    const re = new RegExp('^' + patternOrKey.replace(/\*/g, '.*') + '$');
    for (const k of Array.from(memory.keys())) {
      if (re.test(k)) memory.delete(k);
    }
  } else {
    memory.delete(patternOrKey);
  }
}

export async function bumpInventoryGeneration(): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.incr('inv:gen');
      return;
    } catch {
      /* ignore */
    }
  }
  memory.set('inv:gen', { value: String(Date.now()), expiresAt: Date.now() + 86400_000 });
}
