import { prisma } from '../db/prisma';
import { extractVersionTokens } from '../utils/normalizer';
import {
  extractBrandModelFromTitle,
  identityLooksValid,
  resolveCatalogBrand,
  isBikeText,
  isTrailerText,
} from '../utils/brand-catalog';
import { bumpInventoryGeneration } from '../services/cache.service';
import { refreshInventoryStats } from '../services/inventory.service';
import { logger } from '../services/logger';

// ============================================================
// Limpieza marca/modelo desde título (car-specifications.json)
// Solo vehiculos.revisado = false. Máx. 2h por ejecución.
// TITLE_CLEANUP_RETRY_BAD=1 → reabre los que siguen mal y reintenta.
// ============================================================

const BATCH = 80;
const MAX_MS = parseInt(process.env['TITLE_CLEANUP_MAX_MS'] ?? String(2 * 60 * 60 * 1000), 10);

export async function countPendingTitleCleanup(): Promise<number> {
  return prisma.vehiculo.count({ where: { revisado: false } });
}

/** Marca revisado=false en activos con marca/modelo inválidos (para reintentar). */
export async function requeueBadIdentities(): Promise<number> {
  const now = new Date();
  const rows = await prisma.vehiculo.findMany({
    where: { OR: [{ fecha_fin: null }, { fecha_fin: { gt: now } }] },
    select: {
      id_subasta: true,
      id_lote: true,
      portal: true,
      marca: true,
      modelo: true,
      marcaNorm: true,
      titulo: true,
      revisado: true,
    },
  });

  let n = 0;
  for (const r of rows) {
    const ok = identityLooksValid(r.marca, r.modelo);
    const inFilter =
      isBikeText(r.marca, r.modelo, r.titulo) ||
      isTrailerText(r.marca, r.modelo, r.titulo) ||
      Boolean(resolveCatalogBrand(r.marca) || resolveCatalogBrand(r.marcaNorm));
    if (ok && inFilter) continue;

    await prisma.vehiculo.update({
      where: {
        id_subasta_id_lote_portal: {
          id_subasta: r.id_subasta,
          id_lote: r.id_lote,
          portal: r.portal,
        },
      },
      data: { revisado: false },
    });
    n++;
  }
  return n;
}

export async function ejecutarTitleCleanupJob(opts?: { retryBad?: boolean }): Promise<{
  processed: number;
  fixed: number;
  skippedOk: number;
  unknown: number;
  requeued?: number;
}> {
  let requeued = 0;
  const retry =
    opts?.retryBad === true ||
    (process.env['TITLE_CLEANUP_RETRY_BAD'] ?? '').toLowerCase() === '1' ||
    (process.env['TITLE_CLEANUP_RETRY_BAD'] ?? '').toLowerCase() === 'true' ||
    process.argv.includes('--retry-bad');

  if (retry) {
    requeued = await requeueBadIdentities();
    logger.info(`🧹 Title cleanup: reabriertos ${requeued} con marca/modelo mal`);
  }

  const pending = await countPendingTitleCleanup();
  if (pending === 0) {
    logger.info('🧹 Title cleanup: nada pendiente (revisado=true)');
    return { processed: 0, fixed: 0, skippedOk: 0, unknown: 0, requeued };
  }

  logger.info(`🧹 Title cleanup: ${pending} pendientes · budget ${Math.round(MAX_MS / 60000)} min`);
  const deadline = Date.now() + MAX_MS;
  let processed = 0;
  let fixed = 0;
  let skippedOk = 0;
  let unknown = 0;

  while (Date.now() < deadline) {
    const rows = await prisma.vehiculo.findMany({
      where: { revisado: false },
      select: {
        id_subasta: true,
        id_lote: true,
        portal: true,
        titulo: true,
        marca: true,
        modelo: true,
        marcaNorm: true,
        modeloNorm: true,
      },
      take: BATCH,
      orderBy: { created_at: 'asc' },
    });

    if (!rows.length) break;

    for (const row of rows) {
      if (Date.now() >= deadline) break;

      const parsed = extractBrandModelFromTitle(row.titulo);
      const alreadyOk = identityLooksValid(row.marca, row.modelo);

      if (parsed) {
        const changed =
          row.marca !== parsed.marca ||
          row.modelo !== parsed.modelo ||
          row.marcaNorm !== parsed.marcaNorm ||
          row.modeloNorm !== parsed.modeloNorm;

        await prisma.vehiculo.update({
          where: {
            id_subasta_id_lote_portal: {
              id_subasta: row.id_subasta,
              id_lote: row.id_lote,
              portal: row.portal,
            },
          },
          data: {
            marca: parsed.marca,
            modelo: parsed.modelo,
            marcaNorm: parsed.marcaNorm,
            modeloNorm: parsed.modeloNorm,
            versionTokens: extractVersionTokens(row.titulo, parsed.modelo),
            revisado: true,
          },
        });

        if (changed) fixed++;
        else skippedOk++;
      } else if (alreadyOk) {
        await prisma.vehiculo.update({
          where: {
            id_subasta_id_lote_portal: {
              id_subasta: row.id_subasta,
              id_lote: row.id_lote,
              portal: row.portal,
            },
          },
          data: { revisado: true },
        });
        skippedOk++;
      } else {
        await prisma.vehiculo.update({
          where: {
            id_subasta_id_lote_portal: {
              id_subasta: row.id_subasta,
              id_lote: row.id_lote,
              portal: row.portal,
            },
          },
          data: { revisado: true },
        });
        unknown++;
      }

      processed++;
    }

    if (rows.length < BATCH) break;
  }

  if (fixed > 0) {
    await bumpInventoryGeneration().catch(() => {});
    await refreshInventoryStats().catch((e) =>
      logger.warn(`Title cleanup: rebuild stats falló: ${(e as Error).message}`)
    );
  }

  logger.info(
    `🧹 Title cleanup fin: processed=${processed} fixed=${fixed} ok=${skippedOk} unknown=${unknown}`
  );
  return { processed, fixed, skippedOk, unknown, requeued };
}

/** CLI: node dist/jobs/title-cleanup.job.js [--retry-bad] */
if (require.main === module) {
  ejecutarTitleCleanupJob({ retryBad: process.argv.includes('--retry-bad') })
    .then((r) => {
      console.log(r);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
