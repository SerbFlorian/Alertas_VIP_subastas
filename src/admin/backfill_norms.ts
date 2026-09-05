import 'dotenv/config';
import { prisma } from '../db/prisma';
import { procesarVehiculo } from '../services/sanitizer';
import { logger } from '../services/logger';
import type { Vehiculo } from '../types';

/**
 * Rellena marcaNorm / modeloNorm / versionTokens / ccaaNorm
 * desde los campos ya guardados — sin scrapear ni Bright Data.
 */
async function main(): Promise<void> {
  const rows = await prisma.vehiculo.findMany({
    where: {
      OR: [{ marcaNorm: '' }, { modeloNorm: '' }, { ccaaNorm: '' }],
    },
  });

  logger.info(`🔧 Backfill norms: ${rows.length} filas a revisar`);
  let updated = 0;

  for (const r of rows) {
    const enriched = procesarVehiculo({
      id_subasta: r.id_subasta,
      id_lote: r.id_lote,
      portal: r.portal as Vehiculo['portal'],
      enlace: r.enlace,
      titulo: r.titulo,
      marca: r.marca,
      modelo: r.modelo,
      puja_minima: r.puja_minima,
      fecha_inicio: r.fecha_inicio ?? '',
      fecha_fin: r.fecha_fin ? r.fecha_fin.toISOString() : null,
      provincia: r.provincia ?? undefined,
      comunidad_autonoma: r.comunidad_autonoma ?? undefined,
    });

    await prisma.vehiculo.update({
      where: {
        id_subasta_id_lote_portal: {
          id_subasta: r.id_subasta,
          id_lote: r.id_lote,
          portal: r.portal,
        },
      },
      data: {
        marcaNorm: enriched.marcaNorm,
        modeloNorm: enriched.modeloNorm,
        versionTokens: enriched.versionTokens,
        ccaaNorm: enriched.ccaaNorm,
        provincia: enriched.provincia ?? r.provincia,
        comunidad_autonoma: enriched.comunidad_autonoma ?? r.comunidad_autonoma,
      },
    });
    updated++;
  }

  logger.info(`✅ Backfill listo: ${updated} actualizados`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
