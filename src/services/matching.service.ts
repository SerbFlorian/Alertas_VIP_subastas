import { prisma } from '../db/prisma';
import { getFiltrosUsuario, updateFiltrosUsuario, radarIsConfigured, type RadarFiltros } from '../db/filters.queries';
import { cacheDel, cacheGet, cacheSet } from './cache.service';
import { clearUserQueue, enqueueDigests, type DigestLot } from './queue.service';
import { fingerprintFiltros, normalizeCcaa } from '../utils/normalizer';
import { detectBikeCategory, detectTrailerCategory, isBikeText, isBicicletasBrand, isRemolqueBrand, isTrailerText } from '../utils/brand-catalog';
import { logger } from './logger';

// ============================================================
// Matching — slice by brand/model → Redis digests (≤3 lots)
// ============================================================

const URGENCY_HOURS = 6;

function pujaTolerance(maxPuja: number): number {
  return Math.min(maxPuja * 0.1, 500);
}

function isUrgent(fechaFin?: Date | string | null): boolean {
  if (!fechaFin) return false;
  const t = fechaFin instanceof Date ? fechaFin.getTime() : new Date(fechaFin).getTime();
  if (Number.isNaN(t)) return false;
  return t - Date.now() < URGENCY_HOURS * 3600_000 && t > Date.now();
}

function carMatchesAlert(
  v: {
    marca: string;
    modelo: string;
    titulo: string;
    marcaNorm: string;
    modeloNorm: string;
    versionTokens: string[];
    ccaaNorm: string;
    puja_minima: number;
  },
  alert: RadarFiltros
): boolean {
  if (!alert.marcaNorm && !alert.modeloNorm && !(alert.ccaaNorms?.length) && alert.puja_maxima == null) {
    return false;
  }

  if (isBicicletasBrand(alert.marcaNorm)) {
    if (!isBikeText(v.marca, v.modelo, v.titulo)) return false;
    if (alert.modeloNorm && detectBikeCategory(v.marca, v.modelo, v.titulo) !== alert.modeloNorm) return false;
  } else if (isRemolqueBrand(alert.marcaNorm)) {
    if (!isTrailerText(v.marca, v.modelo, v.titulo)) return false;
    if (alert.modeloNorm && detectTrailerCategory(v.marca, v.modelo, v.titulo) !== alert.modeloNorm) return false;
  } else {
    if (alert.marcaNorm && v.marcaNorm !== alert.marcaNorm) return false;
    if (alert.modeloNorm && v.modeloNorm !== alert.modeloNorm) return false;
  }

  if (alert.ccaaNorms?.length) {
    if (!v.ccaaNorm || !alert.ccaaNorms.includes(v.ccaaNorm)) return false;
  }

  if (alert.puja_maxima != null) {
    const limit = alert.puja_maxima + pujaTolerance(alert.puja_maxima);
    if (v.puja_minima > limit) return false;
  }

  return true;
}

async function loadAlertsForSlice(marcaNorm: string, modeloNorm: string): Promise<RadarFiltros[]> {
  const key = `alerts:idx:${marcaNorm}:${modeloNorm}`;
  const cached = await cacheGet<RadarFiltros[]>(key);
  if (cached) return cached;

  const rows = await prisma.usuarioFiltros.findMany({
    where: {
      OR: [
        { marcaNorm, modeloNorm },
        { marcaNorm, modeloNorm: null },
        { marcaNorm, modeloNorm: '' },
        { marcaNorm: null },
        { marcaNorm: '' },
      ],
      usuario: { estado: { in: ['Pagado', 'Cancelando'] } },
    },
  });

  const alerts = rows.map(mapFiltroRow).filter((a) => a.marcaNorm === marcaNorm || !a.marcaNorm);
  await cacheSet(key, alerts, 180);
  return alerts;
}

function mapFiltroRow(row: any): RadarFiltros {
  return {
    telegram_id: row.telegram_id,
    tipos: JSON.parse(row.tipos || '[]'),
    comunidades: JSON.parse(row.comunidades || '[]'),
    puja_maxima: row.puja_maxima,
    origenes: JSON.parse(row.origenes || '[]'),
    etiquetas: JSON.parse(row.etiquetas || '[]'),
    estados: JSON.parse(row.estados || '[]'),
    marcaNorm: row.marcaNorm || null,
    modeloNorm: row.modeloNorm || null,
    versions: JSON.parse(row.versions || '[]'),
    ccaaNorms: JSON.parse(row.ccaaNorms || '[]'),
    fingerprint: row.fingerprint || null,
  };
}

async function alreadySent(telegramId: string, v: { id_subasta: string; id_lote: string; portal: string }): Promise<boolean> {
  const count = await prisma.notificacionVIPEnviada.count({
    where: {
      telegram_id: telegramId,
      id_subasta: v.id_subasta,
      id_lote: v.id_lote,
      portal: v.portal,
    },
  });
  return count > 0;
}

/**
 * Política VIP (nunca dejar al usuario parado):
 * 1) Primero encola lotes **nuevos** (actualizados en el lookback).
 * 2) Si tras eso la cola del VIP sigue vacía → reseed desde inventario activo
 *    (anuncios “antiguos” aún vigentes, no enviados), p. ej. fin de semana sin scrape.
 */
export async function matchAndEnqueueRecent(lookbackMinutes = 30): Promise<number> {
  const since = new Date(Date.now() - lookbackMinutes * 60_000);
  const vehicles = await prisma.vehiculo.findMany({
    where: {
      updated_at: { gte: since },
      OR: [{ fecha_fin: null }, { fecha_fin: { gt: new Date() } }],
    },
    orderBy: { updated_at: 'desc' },
    take: 500,
  });

  let enqueuedLots = 0;

  if (!vehicles.length) {
    logger.info(
      `ℹ️ Matching lookback ${lookbackMinutes}m: 0 lotes nuevos → fallback inventario (reseed)`
    );
  }

  // 1) Prioridad: matches sobre inventario recién actualizado
  if (vehicles.length) {
    const bySlice = new Map<string, typeof vehicles>();
    for (const v of vehicles) {
      if (!v.marcaNorm) continue;
      const key = `${v.marcaNorm}::${v.modeloNorm}`;
      const arr = bySlice.get(key) ?? [];
      arr.push(v);
      bySlice.set(key, arr);
    }

    const perUser = new Map<string, DigestLot[]>();

    const pushMatch = async (alert: RadarFiltros, v: (typeof vehicles)[0]) => {
      if (!carMatchesAlert(v, alert)) return;
      if (await alreadySent(alert.telegram_id, v)) return;

      const lot: DigestLot = {
        id_subasta: v.id_subasta,
        id_lote: v.id_lote,
        portal: v.portal,
        titulo: v.titulo,
        marca: v.marca,
        modelo: v.modelo,
        puja_minima: v.puja_minima,
        enlace: v.enlace,
        comunidad_autonoma: v.comunidad_autonoma,
        fecha_fin: v.fecha_fin?.toISOString() ?? null,
        urgente: isUrgent(v.fecha_fin),
      };

      const list = perUser.get(alert.telegram_id) ?? [];
      const sameId = list.some(
        (x) => x.id_subasta === lot.id_subasta && x.id_lote === lot.id_lote && x.portal === lot.portal
      );
      if (sameId) return;
      list.push(lot);
      perUser.set(alert.telegram_id, list);
    };

    for (const [slice, cars] of bySlice) {
      const [marcaNorm, modeloNorm] = slice.split('::') as [string, string];
      if (isBicicletasBrand(marcaNorm) || isRemolqueBrand(marcaNorm)) continue;
      const alerts = await loadAlertsForSlice(marcaNorm, modeloNorm || '');
      for (const alert of alerts) {
        if (isBicicletasBrand(alert.marcaNorm) || isRemolqueBrand(alert.marcaNorm)) continue;
        for (const v of cars) await pushMatch(alert, v);
      }
    }

    // Bicicletas: alertas VIP con marca especial vs cualquier lote bici reciente
    const bikeAlertsRaw = await prisma.usuarioFiltros.findMany({
      where: {
        marcaNorm: 'bicicletas',
        usuario: { estado: { in: ['Pagado', 'Cancelando'] } },
      },
    });
    const bikeAlerts = bikeAlertsRaw.map(mapFiltroRow);
    const bikeVehicles = vehicles.filter((v) => isBikeText(v.marca, v.modelo, v.titulo));
    for (const alert of bikeAlerts) {
      for (const v of bikeVehicles) await pushMatch(alert, v);
    }

    // Remolques
    const trailerAlertsRaw = await prisma.usuarioFiltros.findMany({
      where: {
        marcaNorm: 'remolque',
        usuario: { estado: { in: ['Pagado', 'Cancelando'] } },
      },
    });
    const trailerAlerts = trailerAlertsRaw.map(mapFiltroRow);
    const trailerVehicles = vehicles.filter((v) => isTrailerText(v.marca, v.modelo, v.titulo));
    for (const alert of trailerAlerts) {
      for (const v of trailerVehicles) await pushMatch(alert, v);
    }

    for (const [telegramId, lots] of perUser) {
      // Un solo enqueue: urgentes primero. Dos llamadas + LTRIM(-limit) borraban los urgentes.
      const ordered = [
        ...lots.filter((l) => l.urgente),
        ...lots.filter((l) => !l.urgente),
      ].slice(0, 9);
      if (ordered.length) {
        enqueuedLots += await enqueueDigests(telegramId, ordered);
      }
    }

    if (enqueuedLots) {
      logger.info(`🎯 Matching (nuevos): ${enqueuedLots} digest(s) encolados para ${perUser.size} VIP`);
    } else {
      logger.info(
        `ℹ️ Matching lookback ${lookbackMinutes}m: ${vehicles.length} lote(s) nuevos sin match VIP → fallback inventario`
      );
    }
  }

  // 2) Fallback: VIP con radar y cola aún vacía → inventario vigente (no solo lookback)
  const reseeds = await reseedEmptyVipQueues();
  if (reseeds) logger.info(`🌱 Reseed (inventario): ${reseeds} digest(s) en colas vacías`);
  else if (!enqueuedLots) {
    logger.info('ℹ️ Matching+reseed: 0 digests (sin stock que encaje o radar vacío)');
  }

  return enqueuedLots + reseeds;
}

/**
 * Solo VIP con cola vacía: rellena desde inventario activo (no pisa digests ya encolados de lotes nuevos).
 */
export async function reseedEmptyVipQueues(): Promise<number> {
  const { getUsuariosVIPActivos } = await import('../db/queries');
  const { peekQueueLength } = await import('./queue.service');
  const vips = await getUsuariosVIPActivos();
  let total = 0;

  for (const u of vips) {
    const len = await peekQueueLength(u.telegram_id);
    if (len > 0) continue; // ya tiene nuevos (u otros) pendientes → no mezclar fallback encima
    const alert = await getFiltrosUsuario(u.telegram_id);
    if (!radarIsConfigured(alert)) continue;
    const n = await seedQueueFromInventory(u.telegram_id, alert);
    if (n > 0) {
      total += n;
      logger.info(`🌱 Reseed ${u.telegram_id}: ${n} digest(s) desde inventario`);
    }
  }
  return total;
}

export async function replaceFiltersAndResyncQueue(
  telegramId: string,
  next: RadarFiltros
): Promise<{ changed: boolean; seeded: number }> {
  const prev = await getFiltrosUsuario(telegramId);

  const prevFp =
    prev.fingerprint ||
    fingerprintFiltros({
      marcaNorm: prev.marcaNorm,
      modeloNorm: prev.modeloNorm,
      versions: [],
      ccaaNorms: prev.ccaaNorms,
      puja_maxima: prev.puja_maxima,
    });

  next.versions = [];
  if (next.ccaaNorms?.length) {
    next.comunidades = next.ccaaNorms;
  }

  // Defensa: modelo huérfano tras cambio de marca
  if (next.marcaNorm && next.modeloNorm) {
    const { listModelsFromInventory } = await import('./inventory.service');
    const models = await listModelsFromInventory(next.marcaNorm);
    if (!models.some((m) => m.modelNorm === next.modeloNorm)) {
      next.modeloNorm = null;
    }
  }

  next.fingerprint = fingerprintFiltros({
    marcaNorm: next.marcaNorm,
    modeloNorm: next.modeloNorm,
    versions: [],
    ccaaNorms: next.ccaaNorms,
    puja_maxima: next.puja_maxima,
  });
  const changed = prevFp !== next.fingerprint;

  // 1) Sobrescribe siempre el radar en BD (fuente de verdad)
  await updateFiltrosUsuario(next);

  if (!changed) {
    logger.info(`📡 Radar sin cambios para ${telegramId} (fp=${next.fingerprint}) — cola Redis intacta`);
    return { changed: false, seeded: 0 };
  }

  // 2) Cambio detectado → vaciar cola vieja al momento (nada de anuncios del radar anterior)
  await clearUserQueue(telegramId);
  await cacheDel('alerts:idx:*');

  // 3) Rellenar con lotes que encajan YA con el nuevo filtro (máx. 3)
  const seeded = await seedQueueFromInventory(telegramId, next);
  logger.info(
    `🔄 Radar cambiado ${telegramId}: cola vaciada y reseeding=${seeded} digest(s) (fp ${prevFp.slice(0, 40)}… → ${String(next.fingerprint).slice(0, 40)}…)`
  );
  return { changed: true, seeded };
}

async function seedQueueFromInventory(telegramId: string, alert: RadarFiltros): Promise<number> {
  if (!alert.marcaNorm && !alert.ccaaNorms?.length && alert.puja_maxima == null) return 0;

  const { inventoryFilterWhere } = await import('./inventory.service');

  const where: any = {
    AND: [
      { OR: [{ fecha_fin: null }, { fecha_fin: { gt: new Date() } }] },
      inventoryFilterWhere({
        marcaNorm: alert.marcaNorm,
        // para bicis la categoría se aplica en carMatchesAlert
        modeloNorm:
          isBicicletasBrand(alert.marcaNorm) || isRemolqueBrand(alert.marcaNorm)
            ? null
            : alert.modeloNorm || null,
        ccaaNorms: alert.ccaaNorms,
      }),
      // Excluir ya enviados en SQL (evitar starvation si los primeros N están quemados)
      {
        NOT: {
          notificaciones: { some: { telegram_id: telegramId } },
        },
      },
    ],
  };
  if (alert.puja_maxima != null) {
    where.AND.push({ puja_minima: { lte: alert.puja_maxima + pujaTolerance(alert.puja_maxima) } });
  }

  const cars = await prisma.vehiculo.findMany({
    where,
    // Cierre próximo primero; empate → más recién scrapeado
    orderBy: [{ fecha_fin: 'asc' }, { updated_at: 'desc' }],
    take: 40,
  });

  const candidates: DigestLot[] = [];
  for (const v of cars) {
    if (!carMatchesAlert(v, alert)) continue;
    candidates.push({
      id_subasta: v.id_subasta,
      id_lote: v.id_lote,
      portal: v.portal,
      titulo: v.titulo,
      marca: v.marca,
      modelo: v.modelo,
      puja_minima: v.puja_minima,
      enlace: v.enlace,
      comunidad_autonoma: v.comunidad_autonoma,
      fecha_fin: v.fecha_fin?.toISOString() ?? null,
      urgente: isUrgent(v.fecha_fin),
    });
    if (candidates.length >= 12) break;
  }

  if (!candidates.length) return 0;
  // Urgentes primero dentro del fallback de inventario
  candidates.sort((a, b) => Number(b.urgente) - Number(a.urgente));
  return enqueueDigests(telegramId, candidates.slice(0, 3));
}

export { carMatchesAlert, normalizeCcaa };
