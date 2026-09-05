import { scrapearSubastasBOE } from '../scrapers/boe.scraper';
import { EscrapaliaScraper } from '../scrapers/escrapalia.scraper';
import { EactivosScraper } from '../scrapers/eactivos.scraper';
import { ProcuradoresScraper } from '../scrapers/procuradores.scraper';
import { upsertVehiculosLote, registrarEjecucionScraper } from '../db/queries';
import { claimPageWindow, advancePageWindow } from '../utils/scraper-state';
import { logger } from '../services/logger';
import { esVehiculoValido } from '../types';
import { ejecutarMatchingJob } from './notifier.job';
import { ejecutarInventoryStatsJob } from './inventory-stats.job';

// ============================================================
// ORQUESTADOR MULTI-PORTAL + page-window state
// mode all = BOE + Escrapalia + Procuradores + eActivos (HTTP/API; sin Bright Data)
// ============================================================

export type ScraperMode = 'fast' | 'all';

async function runPortalWindow(
  portal: string,
  runner: (pageStart: number, pageEnd: number) => Promise<{
    vehiculos: import('../types').Vehiculo[];
    error?: string;
    lastPageWithResults: number;
    reachedEnd: boolean;
    paginasEscaneadas: number;
  }>
): Promise<{ encontrados: number; nuevos: number }> {
  const window = await claimPageWindow(portal);
  const pageStart = window.start;
  const pageEnd = window.end;

  const inicio = Date.now();
  logger.info(`--- ${portal} ventana ${pageStart}–${pageEnd} (steady=${window.steady}) ---`);

  try {
    const resultado = await runner(pageStart, pageEnd);
    let nuevos = 0;
    if (resultado.vehiculos.length > 0) {
      const validos = resultado.vehiculos.filter(esVehiculoValido);
      if (validos.length) {
        const stats = await upsertVehiculosLote(validos);
        nuevos = stats.nuevo;
        logger.info(`📍 ${portal}: ${validos.length} válidos, ${stats.nuevo} nuevos`);
      }
    }

    await advancePageWindow(portal, {
      lastPageWithResults: resultado.lastPageWithResults || pageStart,
      reachedEnd: resultado.reachedEnd,
      window,
    });

    await registrarEjecucionScraper(
      portal,
      resultado.vehiculos.length,
      nuevos,
      Date.now() - inicio,
      resultado.error
    );

    // En APP_ROLE=scraper el matching/Telegram vive en el contenedor app (cron notifier).
    if (nuevos > 0 && (process.env['APP_ROLE'] ?? 'all') !== 'scraper') {
      ejecutarMatchingJob().catch((e) =>
        logger.error(`❌ Matching bg (${portal}):`, { error: (e as Error).message })
      );
    }

    return { encontrados: resultado.vehiculos.length, nuevos };
  } catch (error) {
    logger.error(`❌ Error en ${portal}: ${(error as Error).message}`);
    await registrarEjecucionScraper(portal, 0, 0, Date.now() - inicio, (error as Error).message);
    return { encontrados: 0, nuevos: 0 };
  }
}

async function runBoe(delayMs: number): Promise<{ encontrados: number; nuevos: number }> {
  return runPortalWindow('BOE', async (pageStart, pageEnd) => {
    const maxPaginas = pageEnd - pageStart + 1;
    const resultado = await scrapearSubastasBOE(maxPaginas, delayMs, pageStart);
    return {
      vehiculos: resultado.vehiculos,
      error: resultado.error,
      lastPageWithResults: Number(resultado.task.extraData?.['lastPageWithResults'] ?? pageEnd),
      reachedEnd: Boolean(resultado.task.extraData?.['reachedEnd']),
      paginasEscaneadas: resultado.paginasEscaneadas,
    };
  });
}

async function runEscrapalia(): Promise<{ encontrados: number; nuevos: number }> {
  const scraper = new EscrapaliaScraper();
  return runPortalWindow('Escrapalia', async (pageStart, pageEnd) => {
    const resultado = await scraper.scrape({
      portal: 'Escrapalia',
      url: 'https://www.escrapalia.com/es/lotes?searchText=subasta_vehiculos',
      extraData: { pageStart, pageEnd },
    });
    return {
      vehiculos: resultado.vehiculos,
      error: resultado.error,
      lastPageWithResults: Number(resultado.task.extraData?.['lastPageWithResults'] ?? pageEnd),
      reachedEnd: Boolean(resultado.task.extraData?.['reachedEnd']),
      paginasEscaneadas: resultado.paginasEscaneadas,
    };
  });
}

async function runProcuradores(): Promise<{ encontrados: number; nuevos: number }> {
  const scraper = new ProcuradoresScraper();
  return runPortalWindow('Procuradores', async (pageStart, pageEnd) => {
    const resultado = await scraper.scrape({
      portal: 'Procuradores',
      url: 'https://www.subastasprocuradores.com/subastas?AssetType=Vehicles',
      extraData: { pageStart, pageEnd },
    });
    return {
      vehiculos: resultado.vehiculos,
      error: resultado.error,
      lastPageWithResults: Number(resultado.task.extraData?.['lastPageWithResults'] ?? pageEnd),
      reachedEnd: Boolean(resultado.task.extraData?.['reachedEnd']),
      paginasEscaneadas: resultado.paginasEscaneadas,
    };
  });
}

async function runEactivos(): Promise<{ encontrados: number; nuevos: number }> {
  const scraper = new EactivosScraper();
  return runPortalWindow('eActivos', async (pageStart, pageEnd) => {
    const resultado = await scraper.scrape({
      portal: 'eActivos',
      url: 'https://www.eactivos.com/listado-de-vehiculos',
      extraData: { pageStart, pageEnd },
    });
    return {
      vehiculos: resultado.vehiculos,
      error: resultado.error,
      lastPageWithResults: Number(resultado.task.extraData?.['lastPageWithResults'] ?? pageEnd),
      reachedEnd: Boolean(resultado.task.extraData?.['reachedEnd']),
      paginasEscaneadas: resultado.paginasEscaneadas,
    };
  });
}

export async function ejecutarScraperJob(mode: ScraperMode = 'all'): Promise<void> {
  const inicioTotal = Date.now();
  const delayMs = parseInt(process.env['REQUEST_DELAY_MS'] ?? '3000', 10);

  logger.info('='.repeat(60));
  logger.info(`🚀 CICLO SCRAPERS mode=${mode}`);
  logger.info('='.repeat(60));

  let totalVehiculosEncontrados = 0;
  let totalNuevos = 0;

  const r1 = await runBoe(delayMs);
  totalVehiculosEncontrados += r1.encontrados;
  totalNuevos += r1.nuevos;

  const r2 = await runEscrapalia();
  totalVehiculosEncontrados += r2.encontrados;
  totalNuevos += r2.nuevos;
  await new Promise((r) => setTimeout(r, 2000));

  const r3 = await runProcuradores();
  totalVehiculosEncontrados += r3.encontrados;
  totalNuevos += r3.nuevos;
  await new Promise((r) => setTimeout(r, 2000));

  const r4 = await runEactivos();
  totalVehiculosEncontrados += r4.encontrados;
  totalNuevos += r4.nuevos;

  try {
    await ejecutarInventoryStatsJob();
  } catch (e) {
    logger.warn(`⚠️ InventoryStats post-scrape: ${(e as Error).message}`);
  }

  const duracionTotal = Date.now() - inicioTotal;
  logger.info('='.repeat(60));
  logger.info(
    `✅ CICLO (${mode}): ${totalVehiculosEncontrados} vehículos (${totalNuevos} nuevos) en ${(duracionTotal / 1000).toFixed(1)}s`
  );
  logger.info('='.repeat(60));
}

if (require.main === module) {
  import('dotenv').then(({ config }) => {
    config();
    const mode = (process.argv[2] as ScraperMode) || 'all';
    return ejecutarScraperJob(mode);
  }).catch(console.error);
}
