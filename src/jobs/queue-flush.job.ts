import { getUsuariosVIPActivos } from '../db/queries';
import { getFiltrosUsuario, radarIsConfigured } from '../db/filters.queries';
import { prisma } from '../db/prisma';
import { listQueuedUserIds, popUserDigests, requeueDigestFront, type DigestLot, type DigestPayload } from '../services/queue.service';
import { carMatchesAlert } from '../services/matching.service';
import {
  clearDigestWarmup,
  hasDigestCooldown,
  isRegularDigestDue,
  listDueDigestWarmups,
  markRegularDigestSent,
  markWarmupDigestSent,
  rescheduleDigestWarmupAt,
} from '../services/warmup.service';
import { enviarMensaje, formatearPrecio } from '../services/telegram.service';
import { normalizeBrand, normalizeCcaa, normalizeModel, semanticLotKey } from '../utils/normalizer';
import { logger } from '../services/logger';
import { ensureRedisReady } from '../db/redis';

// ============================================================
// Queue flusher — cadencia POR USUARIO (NOTIFIER_INTERVAL_MINUTES)
// Warmup: modo='warmup' (no avanza next_regular)
// Regular: tick cron; solo si now >= next_regular
// ============================================================

const SEND_DELAY_MS = parseInt(process.env['NOTIF_SEND_DELAY_MS'] ?? '1000', 10);

export type DigestFlushMode = 'regular' | 'warmup';

/** ≥2 lotes del mismo “lookalike” (mismo coche de flota, distinta matrícula). */
function lookalikeClusterSize(lots: DigestLot[]): number {
  const counts = new Map<string, number>();
  for (const lot of lots) {
    const k = semanticLotKey(lot);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  return max;
}

function formatDigest(payload: DigestPayload): string {
  const lines: string[] = [
    payload.urgent
      ? '⚡ <b>Resumen urgente — cierran pronto</b>'
      : '📬 <b>Resumen VIP — subastas para ti</b>',
    '',
  ];

  const cluster = lookalikeClusterSize(payload.lots);
  if (cluster >= 2) {
    const n = payload.lots.length;
    lines.push(
      `🚨 <b>ATENCIÓN: hay ${n} lotes distintos</b>`,
      `No es el mismo anuncio repetido: cada uno tiene <b>matrícula / enlace propios</b>.`,
      ''
    );
  }

  payload.lots.forEach((lot, i) => {
    const puja = formatearPrecio(lot.puja_minima);
    const where = lot.comunidad_autonoma || 'España';
    const fin = lot.fecha_fin
      ? new Date(lot.fecha_fin).toLocaleString('es-ES', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'Europe/Madrid',
        })
      : 'sin fecha';
    lines.push(
      `<b>${i + 1}. ${lot.marca} ${lot.modelo}</b>`.trim(),
      `${lot.titulo}`.slice(0, 120),
      `💰 Puja desde: <b>${puja}</b>`,
      `📍 <b>${where}</b> · 🕒 ${fin}`,
      `🔗 <a href="${lot.enlace}">Ver subasta (${lot.portal})</a>`,
      ''
    );
  });

  lines.push('<i>Próximo resumen según tu radar · /filtros · /horario</i>');
  return lines.join('\n');
}

function lotId(lot: DigestLot): string {
  return `${lot.portal}|${lot.id_subasta}|${lot.id_lote}`;
}

async function markSent(telegramId: string, payload: DigestPayload, messageId: number): Promise<void> {
  for (const lot of payload.lots) {
    await prisma.notificacionVIPEnviada.upsert({
      where: {
        telegram_id_id_subasta_id_lote_portal: {
          telegram_id: telegramId,
          id_subasta: lot.id_subasta,
          id_lote: lot.id_lote,
          portal: lot.portal,
        },
      },
      create: {
        telegram_id: telegramId,
        id_subasta: lot.id_subasta,
        id_lote: lot.id_lote,
        portal: lot.portal,
        telegram_message_id: messageId,
      },
      update: { telegram_message_id: messageId },
    });
  }
}

/**
 * Flush de un solo usuario.
 * - warmup: ignora next_regular; si envía → solo debounce; respeta ventana /horario del VIP
 * - regular: respeta next_regular + ventana /horario; si envía → avanza cadencia + debounce
 */
export async function flushUserDigests(
  telegramId: string,
  modo: DigestFlushMode = 'regular'
): Promise<number> {
  if (await hasDigestCooldown(telegramId)) {
    logger.info(`⏭️ Flush debounce → ${telegramId}`);
    return 0;
  }

  const { loadDigestPrefs, isUserWithinDeliveryWindow } = await import(
    '../services/digest-schedule.service'
  );
  const prefs = await loadDigestPrefs(telegramId);
  if (!isUserWithinDeliveryWindow(prefs)) {
    return 0;
  }

  if (modo === 'regular' && !(await isRegularDigestDue(telegramId))) {
    return 0;
  }

  const maxMsg = parseInt(process.env['NOTIF_MAX_MESSAGES_PER_USER'] ?? '1', 10);
  const digests = await popUserDigests(telegramId, maxMsg);
  let sent = 0;

  for (const d of digests) {
    try {
      const alert = await getFiltrosUsuario(telegramId);
      const radarOk = radarIsConfigured(alert);

      const unique: DigestLot[] = [];
      const seen = new Set<string>();
      for (const lot of d.lots) {
        const k = lotId(lot);
        if (seen.has(k)) continue;
        seen.add(k);

        if (radarOk) {
          const matches = carMatchesAlert(
            {
              marca: lot.marca,
              modelo: lot.modelo,
              titulo: lot.titulo,
              marcaNorm: normalizeBrand(lot.marca),
              modeloNorm: normalizeModel(lot.modelo),
              versionTokens: [],
              ccaaNorm: normalizeCcaa(lot.comunidad_autonoma),
              puja_minima: lot.puja_minima,
            },
            alert
          );
          if (!matches) {
            logger.info(
              `⏭️ Flush: lote descartado (radar actualizado) ${telegramId} ${lot.portal}/${lot.id_subasta}`
            );
            continue;
          }
        }

        const count = await prisma.notificacionVIPEnviada.count({
          where: {
            telegram_id: telegramId,
            id_subasta: lot.id_subasta,
            id_lote: lot.id_lote,
            portal: lot.portal,
          },
        });
        if (count > 0) continue;
        unique.push(lot);
      }
      if (!unique.length) continue;

      const payload: DigestPayload = { ...d, lots: unique };
      const text = formatDigest(payload);
      const messageId = await enviarMensaje(telegramId, text);
      if (messageId) {
        try {
          await markSent(telegramId, payload, messageId);
          sent++;
        } catch (markErr) {
          // Ya llegó a Telegram: no reencolar (evitar duplicados). Reintentar mark en log.
          logger.error(
            `❌ Digest enviado pero markSent falló → ${telegramId}: ${(markErr as Error).message}`
          );
          sent++;
        }
      } else {
        // Telegram falló → devolver a la cola (antes se perdía tras LPOP)
        await requeueDigestFront(payload);
        logger.warn(`⚠️ Digest reencolado tras fallo Telegram → ${telegramId}`);
      }
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    } catch (error) {
      logger.error(`❌ Flush falló para ${telegramId}: ${(error as Error).message}`);
      try {
        await requeueDigestFront(d);
      } catch {
        /* ignore */
      }
    }
  }

  if (sent > 0) {
    if (modo === 'warmup') {
      await markWarmupDigestSent(telegramId);
    } else {
      await markRegularDigestSent(telegramId);
    }
    logger.info(`📤 Digest ${sent} msg [${modo}] → ${telegramId}`);
  }

  return sent;
}

/** Hard floor sistema (tick cron). La ventana real es por VIP vía /horario. */
export function enVentanaHardFloor(): boolean {
  const start = Math.max(0, parseInt(process.env['NOTIF_HARD_START_HOUR'] ?? '7', 10));
  const end = Math.min(23, parseInt(process.env['NOTIF_HARD_END_HOUR'] ?? '23', 10));
  const raw = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  let h = parseInt(raw, 10);
  if (h === 24) h = 0;
  return h >= start && h < end;
}

/** @deprecated Prefer enVentanaHardFloor + prefs por usuario */
export function enVentanaDigest(): boolean {
  return enVentanaHardFloor();
}

/** Tick regular: VIP con cola, dentro de su /horario y next_regular vencido. */
export async function ejecutarQueueFlushJob(): Promise<void> {
  if (!(await ensureRedisReady())) {
    logger.error('❌ Flush regular abortado: Redis no disponible');
    return;
  }
  if (!enVentanaHardFloor()) {
    logger.info('⏭️ Flush regular: fuera del hard floor Madrid');
    return;
  }

  const vipIds = new Set((await getUsuariosVIPActivos()).map((u) => u.telegram_id));
  const queued = await listQueuedUserIds();
  const candidates = queued.filter((id) => vipIds.has(id));

  logger.info(`📤 Flush cola VIP (tick): ${candidates.length} con cola`);
  let sent = 0;
  let skipped = 0;

  for (const telegramId of candidates) {
    const n = await flushUserDigests(telegramId, 'regular');
    if (n > 0) sent += n;
    else skipped++;
  }

  logger.info(`✅ Flush tick: ${sent} mensajes · ${skipped} skip/vacío/no-due`);
}

/** Warmups vencidos. Respeta /horario de cada VIP. No avanza next_regular. */
export async function procesarWarmupsDue(): Promise<void> {
  if (!(await ensureRedisReady())) return;
  if (!enVentanaHardFloor()) return;

  const dueIds = await listDueDigestWarmups();
  if (dueIds.length === 0) return;

  logger.info(`🔥 Warmup due: ${dueIds.length} usuario(s)`);

  const vipIds = new Set((await getUsuariosVIPActivos()).map((u) => u.telegram_id));
  const { loadDigestPrefs, isUserWithinDeliveryWindow, calcularDueWarmupEnVentana } = await import(
    '../services/digest-schedule.service'
  );

  for (const telegramId of dueIds) {
    if (!vipIds.has(telegramId)) {
      await clearDigestWarmup(telegramId);
      continue;
    }
    try {
      const prefs = await loadDigestPrefs(telegramId);
      if (!isUserWithinDeliveryWindow(prefs)) {
        const nextDue = calcularDueWarmupEnVentana(prefs, 0);
        await rescheduleDigestWarmupAt(telegramId, nextDue);
        continue;
      }

      await clearDigestWarmup(telegramId);
      const n = await flushUserDigests(telegramId, 'warmup');
      if (n === 0) {
        // No quemar cuota: reintentar en 5 min dentro de su ventana
        const retryAt = calcularDueWarmupEnVentana(prefs, 5);
        await rescheduleDigestWarmupAt(telegramId, retryAt);
        logger.info(`ℹ️ Warmup sin envío → ${telegramId} reintento ~5 min (sin quemar cuota)`);
      }
    } catch (error) {
      logger.error(`❌ Warmup falló ${telegramId}:`, { error });
    }
  }
}

if (require.main === module) {
  import('dotenv')
    .then(({ config }) => {
      config();
      return import('../db/redis').then(({ ensureRedisReady }) => ensureRedisReady());
    })
    .then(() => ejecutarQueueFlushJob())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
