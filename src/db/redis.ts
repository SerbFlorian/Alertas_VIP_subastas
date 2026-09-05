import Redis from 'ioredis';
import { logger } from '../services/logger';

// ============================================================
// Redis client — fail-open (memory fallback lives in queue/cache services)
// ============================================================

let redis: Redis | null = null;
let redisAvailable = false;

export function getRedis(): Redis | null {
  return redisAvailable ? redis : null;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export async function initRedis(): Promise<void> {
  const url = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  // Ya conectado
  if (redis && redisAvailable) return;

  try {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
      redis = null;
    }

    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5000,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });

    redis.on('error', (err) => {
      if (redisAvailable) {
        logger.warn(`⚠️ Redis error — falling back to memory: ${err.message}`);
      }
      redisAvailable = false;
    });

    redis.on('connect', () => {
      redisAvailable = true;
      logger.info('✅ Redis conectado');
    });

    redis.on('close', () => {
      redisAvailable = false;
    });

    await redis.connect();
    const pong = await redis.ping();
    redisAvailable = pong === 'PONG';
    if (redisAvailable) {
      logger.info(`✅ Redis listo (${url.replace(/\/\/.*@/, '//***@')})`);
    }
  } catch (error) {
    redisAvailable = false;
    logger.warn(`⚠️ Redis no disponible — modo memoria: ${(error as Error).message}`);
  }
}

/** Garantiza cliente Redis antes de encolar/flush (scripts CLI y jobs). */
export async function ensureRedisReady(): Promise<boolean> {
  if (isRedisAvailable()) return true;
  await initRedis();
  if (!isRedisAvailable()) {
    logger.error(
      '❌ Redis obligatorio para colas VIP — digests en memoria se pierden al salir del proceso'
    );
  }
  return isRedisAvailable();
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    redis = null;
    redisAvailable = false;
  }
}
