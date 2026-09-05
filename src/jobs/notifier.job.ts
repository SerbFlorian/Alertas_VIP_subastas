import { getVehiculosParaPublico, marcarVehiculoComoPublicado } from '../db/queries';
import { enviarMensaje, formatearMensajeVehiculoPublico } from '../services/telegram.service';
import { matchAndEnqueueRecent } from '../services/matching.service';
import { ensureRedisReady, disconnectRedis } from '../db/redis';
import { logger } from '../services/logger';

// ============================================================
// NOTIFIER JOBS
// - VIP: matching → Redis digests (flush por cadencia/usuario)
// - Público: FOMO canal — 1×/día a las 10:00 Madrid (cron aparte)
// ============================================================

const TELEGRAM_MSG_DELAY_MS = 1000;

/** Fijo: canal gratuito todos los días a las 10:00 Europe/Madrid. */
export const PUBLIC_CHANNEL_CRON = '0 10 * * *';
export const PUBLIC_CHANNEL_TZ = 'Europe/Madrid';

async function enviarConThrottle(fn: () => Promise<void>): Promise<void> {
  await fn();
  await new Promise((r) => setTimeout(r, TELEGRAM_MSG_DELAY_MS));
}

let isMatchingRunning = false;
let isPublicoRunning = false;

/** Encola matches VIP recientes + reseed colas vacías (sin tocar el canal público). */
export async function ejecutarMatchingJob(): Promise<void> {
  if (isMatchingRunning) {
    logger.info('⏳ Matching ya está en ejecución, saltando ciclo...');
    return;
  }
  isMatchingRunning = true;
  try {
    if (!(await ensureRedisReady())) {
      logger.error('❌ Matching abortado: Redis no disponible (no encolar en memoria)');
      return;
    }
    const matchingMins = parseInt(process.env['MATCHING_INTERVAL_MINUTES'] ?? '30', 10);
    // Default 24 h: scrapers L–V 8/14/20; lookback corto dejaba VIP sin cola entre ciclos
    const lookback = parseInt(
      process.env['NOTIFIER_LOOKBACK_MINUTES'] ?? String(Math.max(24 * 60, matchingMins + 5)),
      10
    );
    const enqueued = await matchAndEnqueueRecent(lookback);
    if (enqueued) logger.info(`🎯 VIP matching: ${enqueued} digest(s) encolados (lookback ${lookback}m)`);
  } finally {
    isMatchingRunning = false;
  }
}

/** Publica en el canal gratuito (cupo diario, sin enlace). Llamado solo por cron 10:00. */
export async function ejecutarCanalPublicoJob(): Promise<void> {
  if (isPublicoRunning) {
    logger.info('⏳ Canal público ya está en ejecución, saltando...');
    return;
  }
  isPublicoRunning = true;
  try {
    const channelPublicoId = process.env['TELEGRAM_CHANNEL_PUBLICO_ID'];
    if (!channelPublicoId) {
      logger.error('❌ Falta TELEGRAM_CHANNEL_PUBLICO_ID en .env');
      return;
    }

    const { getPublicacionesPublicasHoyCount } = await import('../db/queries');
    const maxPublicosDiarios = parseInt(process.env['MAX_PUBLICACIONES_PUBLICAS_DIARIAS'] ?? '1', 10);
    const publicadosHoy = await getPublicacionesPublicasHoyCount();
    const cupoDisponible = Math.max(0, maxPublicosDiarios - publicadosHoy);

    if (cupoDisponible <= 0) {
      logger.info(`ℹ️ [PUBLICO] Cupo diario agotado (${publicadosHoy}/${maxPublicosDiarios})`);
      return;
    }

    const vehiculosPublicos = await getVehiculosParaPublico(cupoDisponible);
    if (vehiculosPublicos.length === 0) {
      logger.info('ℹ️ [PUBLICO] Sin lotes elegibles (cierran en 3–24 h)');
      return;
    }

    let enviadosPublicos = 0;
    for (const v of vehiculosPublicos) {
      try {
        const mensaje = formatearMensajeVehiculoPublico(v);
        await enviarConThrottle(async () => {
          const messageId = await enviarMensaje(channelPublicoId, mensaje, undefined, {
            disableWebPagePreview: false,
          });
          if (messageId) {
            await marcarVehiculoComoPublicado(v.id_subasta, v.id_lote ?? undefined, v.portal, 'publico', messageId);
            enviadosPublicos++;
            logger.info(
              `✅ [PUBLICO] FOMO (${enviadosPublicos + publicadosHoy}/${maxPublicosDiarios}): ${v.marca} ${v.modelo}`
            );
          } else {
            logger.warn(
              `⚠️ [PUBLICO] Send fallido — no se marca publicado: ${v.marca} ${v.modelo}`
            );
          }
        });
      } catch (error) {
        logger.error(`❌ Error publicando Público ${v.id_subasta}: ${(error as Error).message}`);
      }
    }

    if (enviadosPublicos > 0) {
      logger.info(`📊 Canal público: ${enviadosPublicos} publicación(es) FOMO`);
    }
  } finally {
    isPublicoRunning = false;
  }
}

/** @deprecated Usar ejecutarMatchingJob o ejecutarCanalPublicoJob. */
export async function ejecutarNotifierJob(): Promise<void> {
  await ejecutarMatchingJob();
}

if (require.main === module) {
  import('dotenv')
    .then(({ config }) => {
      config();
      return ensureRedisReady();
    })
    .then(() => ejecutarMatchingJob())
    .then(() => disconnectRedis())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
