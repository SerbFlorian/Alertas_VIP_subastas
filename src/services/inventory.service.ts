import { prisma } from '../db/prisma';
import { cacheGet, cacheSet, bumpInventoryGeneration } from './cache.service';
import { canonicalizeCcaa, isUsableModelLabel, normalizeCcaa, normalizeModel } from '../utils/normalizer';
import {
  BICICLETAS_BRAND_NORM,
  BICICLETAS_LABEL,
  BIKE_CATEGORY_LABELS,
  detectBikeCategory,
  isBikeText,
  isBicicletasBrand,
  REMOLQUE_BRAND_NORM,
  REMOLQUE_LABEL,
  TRAILER_CATEGORY_LABELS,
  detectTrailerCategory,
  isTrailerText,
  isRemolqueBrand,
  resolveCatalogBrand,
  type BikeCategory,
  type TrailerCategory,
} from '../utils/brand-catalog';
import { logger } from './logger';

// ============================================================
// Inventory service — filter UX backed by live / stats stock
// ============================================================

export interface StockContext {
  count: number;
  pujaMin: number | null;
  pujaMax: number | null;
  pujaAvg: number | null;
}

export function formatStockLine(ctx: StockContext, _label = 'vehículos'): string {
  if (!ctx.count) return `(Inventario: sin resultados ahora mismo)`;
  const min = ctx.pujaMin != null ? Math.round(ctx.pujaMin).toLocaleString('es-ES') + '€' : '—';
  const max = ctx.pujaMax != null ? Math.round(ctx.pujaMax).toLocaleString('es-ES') + '€' : '—';
  const avg = ctx.pujaAvg != null ? Math.round(ctx.pujaAvg).toLocaleString('es-ES') + '€' : '—';
  return `(Inventario: ${min} - ${max} | Media: ${avg})`;
}

function activeWhere(extra: Record<string, unknown> = {}) {
  return {
    AND: [
      {
        OR: [{ fecha_fin: null }, { fecha_fin: { gt: new Date() } }],
      },
      extra,
    ],
  };
}

/** Where clause that understands marca Bicicletas + categorías de bici */
export function inventoryFilterWhere(filter: {
  marcaNorm?: string | null;
  modeloNorm?: string | null;
  ccaaNorms?: string[];
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (filter.ccaaNorms?.length) extra['ccaaNorm'] = { in: filter.ccaaNorms };

  if (isBicicletasBrand(filter.marcaNorm)) {
    // Amplio: marca bicicleta* O título/modelo con pistas (aprox vía OR de contains)
    extra['OR'] = [
      { marcaNorm: { in: ['bicicleta', 'bicicletas', 'bici'] } },
      { marca: { contains: 'Bicicleta', mode: 'insensitive' } },
      { titulo: { contains: 'bicicleta', mode: 'insensitive' } },
      { titulo: { contains: 'Bicicleta', mode: 'insensitive' } },
      { modelo: { contains: 'bicicleta', mode: 'insensitive' } },
      { titulo: { contains: 'e-bike', mode: 'insensitive' } },
      { titulo: { contains: 'ebike', mode: 'insensitive' } },
      { titulo: { contains: 'MTB', mode: 'insensitive' } },
    ];
  } else if (isRemolqueBrand(filter.marcaNorm)) {
    extra['OR'] = [
      { marcaNorm: { in: [REMOLQUE_BRAND_NORM, 'remolques'] } },
      { marca: { contains: 'Remolque', mode: 'insensitive' } },
      { titulo: { contains: 'remolque', mode: 'insensitive' } },
      { titulo: { contains: 'Remolque', mode: 'insensitive' } },
      { titulo: { contains: 'portacoches', mode: 'insensitive' } },
      { titulo: { contains: 'trailer', mode: 'insensitive' } },
    ];
  } else if (filter.marcaNorm) {
    extra['marcaNorm'] = filter.marcaNorm;
    if (filter.modeloNorm) extra['modeloNorm'] = filter.modeloNorm;
  } else if (filter.modeloNorm) {
    extra['modeloNorm'] = filter.modeloNorm;
  }
  return extra;
}

export async function listBrandsFromInventory(): Promise<Array<{ brandNorm: string; label: string; count: number }>> {
  const cached = await cacheGet<Array<{ brandNorm: string; label: string; count: number }>>('inv:brands:v2');
  if (cached) return cached;

  const rows = await prisma.vehiculo.findMany({
    where: activeWhere({}),
    select: { marca: true, marcaNorm: true, modelo: true, titulo: true },
    take: 8000,
  });

  const map = new Map<string, { brandNorm: string; label: string; count: number }>();

  for (const r of rows) {
    if (isBikeText(r.marca, r.modelo, r.titulo)) {
      const prev = map.get(BICICLETAS_BRAND_NORM);
      if (!prev) map.set(BICICLETAS_BRAND_NORM, { brandNorm: BICICLETAS_BRAND_NORM, label: BICICLETAS_LABEL, count: 1 });
      else prev.count += 1;
      continue;
    }

    if (isTrailerText(r.marca, r.modelo, r.titulo)) {
      const prev = map.get(REMOLQUE_BRAND_NORM);
      if (!prev) map.set(REMOLQUE_BRAND_NORM, { brandNorm: REMOLQUE_BRAND_NORM, label: REMOLQUE_LABEL, count: 1 });
      else prev.count += 1;
      continue;
    }

    const resolved = resolveCatalogBrand(r.marca) || resolveCatalogBrand(r.marcaNorm);
    if (!resolved) {
      // Activos sin marca catálogo → Otros (visibles en filtro)
      const prev = map.get('otros');
      if (!prev) map.set('otros', { brandNorm: 'otros', label: 'Otros', count: 1 });
      else prev.count += 1;
      continue;
    }

    const prev = map.get(resolved.norm);
    if (!prev) map.set(resolved.norm, { brandNorm: resolved.norm, label: resolved.label, count: 1 });
    else prev.count += 1;
  }

  const list = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
  await cacheSet('inv:brands:v2', list, 900);
  return list;
}

export async function listModelsFromInventory(brandNorm: string): Promise<Array<{ modelNorm: string; label: string; count: number }>> {
  const key = `inv:models:v2:${brandNorm}`;
  const cached = await cacheGet<Array<{ modelNorm: string; label: string; count: number }>>(key);
  if (cached) return cached;

  if (isBicicletasBrand(brandNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: BICICLETAS_BRAND_NORM })),
      select: { marca: true, modelo: true, titulo: true },
      take: 3000,
    });

    const counts = new Map<BikeCategory, number>();
    for (const r of rows) {
      if (!isBikeText(r.marca, r.modelo, r.titulo)) continue;
      const cat = detectBikeCategory(r.marca, r.modelo, r.titulo);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }

    const list = (Object.keys(BIKE_CATEGORY_LABELS) as BikeCategory[])
      .filter((c) => (counts.get(c) ?? 0) > 0)
      .map((c) => ({
        modelNorm: c,
        label: BIKE_CATEGORY_LABELS[c],
        count: counts.get(c) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));

    await cacheSet(key, list, 600);
    return list;
  }

  if (isRemolqueBrand(brandNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: REMOLQUE_BRAND_NORM })),
      select: { marca: true, modelo: true, titulo: true },
      take: 3000,
    });

    const counts = new Map<TrailerCategory, number>();
    for (const r of rows) {
      if (!isTrailerText(r.marca, r.modelo, r.titulo)) continue;
      const cat = detectTrailerCategory(r.marca, r.modelo, r.titulo);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }

    const list = (Object.keys(TRAILER_CATEGORY_LABELS) as TrailerCategory[])
      .filter((c) => (counts.get(c) ?? 0) > 0)
      .map((c) => ({
        modelNorm: c,
        label: TRAILER_CATEGORY_LABELS[c],
        count: counts.get(c) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));

    await cacheSet(key, list, 600);
    return list;
  }

  const rows = await prisma.vehiculo.groupBy({
    by: ['modeloNorm', 'modelo'],
    where: activeWhere({ marcaNorm: brandNorm }),
    _count: { _all: true },
    orderBy: { _count: { modeloNorm: 'desc' } },
  });

  const map = new Map<string, { modelNorm: string; label: string; count: number }>();
  for (const r of rows as any[]) {
    if (!isUsableModelLabel(r.modelo)) continue;
    if (/^\d+$/.test(String(r.modelo).trim())) continue;
    const modelNorm = r.modeloNorm || normalizeModel(r.modelo);
    if (!modelNorm || /^\d+$/.test(modelNorm)) continue;
    const prev = map.get(modelNorm);
    const count = r._count._all;
    if (!prev) map.set(modelNorm, { modelNorm, label: r.modelo, count });
    else prev.count += count;
  }

  const list = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
  await cacheSet(key, list, 600);
  return list;
}

export async function listVersionTokensFromInventory(brandNorm: string, modelNorm: string): Promise<Array<{ token: string; count: number }>> {
  const key = `inv:versions:${brandNorm}:${modelNorm}`;
  const cached = await cacheGet<Array<{ token: string; count: number }>>(key);
  if (cached) return cached;

  const rows = await prisma.vehiculo.findMany({
    where: activeWhere({ marcaNorm: brandNorm, modeloNorm: modelNorm }),
    select: { versionTokens: true },
    take: 500,
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.versionTokens ?? []) {
      const token = t.trim().toLowerCase();
      if (!token || token.length < 2) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const list = Array.from(counts.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, 40);

  await cacheSet(key, list, 600);
  return list;
}

export async function listCcaaFromInventory(filter?: {
  marcaNorm?: string | null;
  modeloNorm?: string | null;
  versions?: string[];
}): Promise<Array<{ ccaaNorm: string; label: string; count: number }>> {
  const cacheKey = `inv:ccaa:v2:${filter?.marcaNorm ?? ''}:${filter?.modeloNorm ?? ''}`;
  const cached = await cacheGet<Array<{ ccaaNorm: string; label: string; count: number }>>(cacheKey);
  if (cached) return cached;

  if (isBicicletasBrand(filter?.marcaNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: BICICLETAS_BRAND_NORM, ccaaNorms: undefined })),
      select: { marca: true, modelo: true, titulo: true, ccaaNorm: true, comunidad_autonoma: true },
      take: 3000,
    });
    const map = new Map<string, { ccaaNorm: string; label: string; count: number }>();
    for (const r of rows) {
      if (!isBikeText(r.marca, r.modelo, r.titulo)) continue;
      if (filter?.modeloNorm && detectBikeCategory(r.marca, r.modelo, r.titulo) !== filter.modeloNorm) continue;
      const ccaaNorm = r.ccaaNorm || normalizeCcaa(r.comunidad_autonoma);
      if (!ccaaNorm) continue;
      const label = canonicalizeCcaa(r.comunidad_autonoma) || r.comunidad_autonoma || ccaaNorm;
      const prev = map.get(ccaaNorm);
      if (!prev) map.set(ccaaNorm, { ccaaNorm, label, count: 1 });
      else prev.count += 1;
    }
    const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
    await cacheSet(cacheKey, list, 600);
    return list;
  }

  if (isRemolqueBrand(filter?.marcaNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: REMOLQUE_BRAND_NORM, ccaaNorms: undefined })),
      select: { marca: true, modelo: true, titulo: true, ccaaNorm: true, comunidad_autonoma: true },
      take: 3000,
    });
    const map = new Map<string, { ccaaNorm: string; label: string; count: number }>();
    for (const r of rows) {
      if (!isTrailerText(r.marca, r.modelo, r.titulo)) continue;
      if (filter?.modeloNorm && detectTrailerCategory(r.marca, r.modelo, r.titulo) !== filter.modeloNorm) continue;
      const ccaaNorm = r.ccaaNorm || normalizeCcaa(r.comunidad_autonoma);
      if (!ccaaNorm) continue;
      const label = canonicalizeCcaa(r.comunidad_autonoma) || r.comunidad_autonoma || ccaaNorm;
      const prev = map.get(ccaaNorm);
      if (!prev) map.set(ccaaNorm, { ccaaNorm, label, count: 1 });
      else prev.count += 1;
    }
    const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
    await cacheSet(cacheKey, list, 600);
    return list;
  }

  const whereExtra = {
    ccaaNorm: { not: '' },
    ...inventoryFilterWhere({
      marcaNorm: filter?.marcaNorm,
      modeloNorm: filter?.modeloNorm,
    }),
  };

  const rows = await prisma.vehiculo.groupBy({
    by: ['ccaaNorm', 'comunidad_autonoma'],
    where: activeWhere(whereExtra),
    _count: { _all: true },
    orderBy: { _count: { ccaaNorm: 'desc' } },
  });

  const map = new Map<string, { ccaaNorm: string; label: string; count: number }>();
  for (const r of rows as any[]) {
    const ccaaNorm = r.ccaaNorm || normalizeCcaa(r.comunidad_autonoma);
    if (!ccaaNorm) continue;
    const label = canonicalizeCcaa(r.comunidad_autonoma) || r.comunidad_autonoma || ccaaNorm;
    const prev = map.get(ccaaNorm);
    if (!prev) map.set(ccaaNorm, { ccaaNorm, label, count: r._count._all });
    else prev.count += r._count._all;
  }

  const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
  await cacheSet(cacheKey, list, 600);
  return list;
}

export async function getStockContext(filter: {
  marcaNorm?: string | null;
  modeloNorm?: string | null;
  versions?: string[];
  ccaaNorms?: string[];
}): Promise<StockContext> {
  const key = `inv:ctx:v2:${filter.marcaNorm ?? ''}:${filter.modeloNorm ?? ''}:${(filter.ccaaNorms ?? []).join(',')}`;
  const cached = await cacheGet<StockContext>(key);
  if (cached) return cached;

  if (isBicicletasBrand(filter.marcaNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: BICICLETAS_BRAND_NORM, ccaaNorms: filter.ccaaNorms })),
      select: { marca: true, modelo: true, titulo: true, puja_minima: true },
      take: 3000,
    });
    const pujas: number[] = [];
    for (const r of rows) {
      if (!isBikeText(r.marca, r.modelo, r.titulo)) continue;
      if (filter.modeloNorm && detectBikeCategory(r.marca, r.modelo, r.titulo) !== filter.modeloNorm) continue;
      pujas.push(r.puja_minima);
    }
    const ctx: StockContext = {
      count: pujas.length,
      pujaMin: pujas.length ? Math.min(...pujas) : null,
      pujaMax: pujas.length ? Math.max(...pujas) : null,
      pujaAvg: pujas.length ? pujas.reduce((a, b) => a + b, 0) / pujas.length : null,
    };
    await cacheSet(key, ctx, 300);
    return ctx;
  }

  if (isRemolqueBrand(filter.marcaNorm)) {
    const rows = await prisma.vehiculo.findMany({
      where: activeWhere(inventoryFilterWhere({ marcaNorm: REMOLQUE_BRAND_NORM, ccaaNorms: filter.ccaaNorms })),
      select: { marca: true, modelo: true, titulo: true, puja_minima: true },
      take: 3000,
    });
    const pujas: number[] = [];
    for (const r of rows) {
      if (!isTrailerText(r.marca, r.modelo, r.titulo)) continue;
      if (filter.modeloNorm && detectTrailerCategory(r.marca, r.modelo, r.titulo) !== filter.modeloNorm) continue;
      pujas.push(r.puja_minima);
    }
    const ctx: StockContext = {
      count: pujas.length,
      pujaMin: pujas.length ? Math.min(...pujas) : null,
      pujaMax: pujas.length ? Math.max(...pujas) : null,
      pujaAvg: pujas.length ? pujas.reduce((a, b) => a + b, 0) / pujas.length : null,
    };
    await cacheSet(key, ctx, 300);
    return ctx;
  }

  const agg = await prisma.vehiculo.aggregate({
    where: activeWhere(
      inventoryFilterWhere({
        marcaNorm: filter.marcaNorm,
        modeloNorm: filter.modeloNorm,
        ccaaNorms: filter.ccaaNorms,
      })
    ),
    _count: { _all: true },
    _min: { puja_minima: true },
    _max: { puja_minima: true },
    _avg: { puja_minima: true },
  });

  const ctx: StockContext = {
    count: agg._count._all,
    pujaMin: agg._min.puja_minima,
    pujaMax: agg._max.puja_minima,
    pujaAvg: agg._avg.puja_minima,
  };
  await cacheSet(key, ctx, 300);
  return ctx;
}

export function buildPujaButtons(ctx: StockContext): Array<{ label: string; value: number | null }> {
  const buttons: Array<{ label: string; value: number | null }> = [];
  if (ctx.pujaAvg && ctx.pujaAvg > 0) {
    const avg = Math.round(ctx.pujaAvg);
    const candidates = [
      Math.max(500, Math.round(avg * 0.5)),
      Math.max(500, Math.round(avg * 0.75)),
      avg,
      Math.round(avg * 1.25),
      Math.round((ctx.pujaMax ?? avg) * 1.1),
    ];
    const uniq = Array.from(new Set(candidates)).sort((a, b) => a - b);
    for (const v of uniq.slice(0, 5)) {
      buttons.push({ label: `Hasta ${v.toLocaleString('es-ES')}€`, value: v });
    }
  } else {
    for (const v of [1000, 3000, 5000, 10000, 20000]) {
      buttons.push({ label: `Hasta ${v.toLocaleString('es-ES')}€`, value: v });
    }
  }
  buttons.push({ label: 'Cualquier puja', value: null });
  return buttons;
}

export async function refreshInventoryStats(): Promise<void> {
  logger.info('📊 Refrescando InventoryStats...');
  const active = await prisma.vehiculo.findMany({
    where: activeWhere({ marcaNorm: { not: '' } }),
    select: {
      marcaNorm: true,
      modeloNorm: true,
      versionTokens: true,
      ccaaNorm: true,
      puja_minima: true,
    },
    take: 5000,
  });

  type Acc = { count: number; sum: number; min: number; max: number };
  const buckets = new Map<string, Acc & { marcaNorm: string; modeloNorm: string; versionToken: string; ccaaNorm: string }>();

  const bump = (marcaNorm: string, modeloNorm: string, versionToken: string, ccaaNorm: string, puja: number) => {
    const key = `${marcaNorm}|${modeloNorm}|${versionToken}|${ccaaNorm}`;
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, { marcaNorm, modeloNorm, versionToken, ccaaNorm, count: 1, sum: puja, min: puja, max: puja });
    } else {
      prev.count += 1;
      prev.sum += puja;
      prev.min = Math.min(prev.min, puja);
      prev.max = Math.max(prev.max, puja);
    }
  };

  for (const v of active) {
    bump(v.marcaNorm, '', '', '', v.puja_minima);
    if (v.modeloNorm) bump(v.marcaNorm, v.modeloNorm, '', '', v.puja_minima);
    if (v.ccaaNorm) bump(v.marcaNorm, v.modeloNorm || '', '', v.ccaaNorm, v.puja_minima);
    for (const token of (v.versionTokens ?? []).slice(0, 8)) {
      bump(v.marcaNorm, v.modeloNorm || '', token, '', v.puja_minima);
    }
  }

  await prisma.inventoryStats.deleteMany({});
  const values = Array.from(buckets.values());
  const chunk = 200;
  for (let i = 0; i < values.length; i += chunk) {
    const slice = values.slice(i, i + chunk);
    await prisma.inventoryStats.createMany({
      data: slice.map((b) => ({
        marcaNorm: b.marcaNorm,
        modeloNorm: b.modeloNorm,
        versionToken: b.versionToken,
        ccaaNorm: b.ccaaNorm,
        count: b.count,
        pujaMin: b.min,
        pujaMax: b.max,
        pujaAvg: b.sum / b.count,
      })),
    });
  }

  await bumpInventoryGeneration();
  await cacheDelInventory();
  logger.info(`📊 InventoryStats: ${values.length} buckets`);
}

async function cacheDelInventory(): Promise<void> {
  const { cacheDel } = await import('./cache.service');
  await cacheDel('inv:*');
}
