import { prisma } from '../db/prisma';
import { logger } from '../services/logger';

export interface PageWindow {
  start: number;
  end: number;
  steady: boolean;
}

function windowSize(): number {
  return Math.max(1, parseInt(process.env['SCRAPER_WINDOW_SIZE'] ?? '5', 10));
}

function steadyPages(): number {
  return Math.max(1, parseInt(process.env['SCRAPER_STEADY_PAGES'] ?? '5', 10));
}

function steadyOnly(): boolean {
  return (process.env['SCRAPER_STEADY_ONLY'] ?? 'true').toLowerCase() !== 'false';
}

/**
 * Discovery: ventanas de SCRAPER_WINDOW_SIZE → 1–5, 6–10, …
 * Steady (default): siempre páginas 1..SCRAPER_STEADY_PAGES (lo nuevo está al inicio).
 */
export async function claimPageWindow(portal: string): Promise<PageWindow> {
  const size = windowSize();
  const steady = steadyPages();
  const onlySteady = steadyOnly();

  const state = await prisma.scraperState.upsert({
    where: { portal },
    create: { portal, nextWindowStart: 1, fullyCrawled: false, lastPageSeen: 0 },
    update: {},
  });

  if (onlySteady) {
    if (!state.fullyCrawled) {
      await prisma.scraperState.update({
        where: { portal },
        data: { fullyCrawled: true, nextWindowStart: 1, lastRunAt: new Date() },
      });
    } else {
      await prisma.scraperState.update({
        where: { portal },
        data: { lastRunAt: new Date() },
      });
    }
    logger.info(`📄 [${portal}] Modo steady: páginas 1–${steady}`);
    return { start: 1, end: steady, steady: true };
  }

  // Discovery: si un ciclo anterior marcó fullyCrawled, reinicia desde 1
  let start = Math.max(1, state.nextWindowStart);
  if (state.fullyCrawled) {
    start = 1;
    await prisma.scraperState.update({
      where: { portal },
      data: { fullyCrawled: false, nextWindowStart: 1, lastRunAt: new Date() },
    });
  }

  const end = start + size - 1;
  logger.info(`📄 [${portal}] Ventana discovery: páginas ${start}–${end} (paso ${size})`);
  return { start, end, steady: false };
}

/**
 * Tras cada ciclo:
 * - ventana completa → siguiente banda (21–40, …)
 * - fin real del catálogo (reachedEnd) → marca fullyCrawled
 * - corte a medias → continúa desde lastPage+1 (no se queda en 1–20)
 */
export async function advancePageWindow(
  portal: string,
  opts: { lastPageWithResults: number; reachedEnd: boolean; window: PageWindow }
): Promise<void> {
  const size = windowSize();

  if (opts.window.steady) {
    await prisma.scraperState.update({
      where: { portal },
      data: {
        lastPageSeen: opts.lastPageWithResults,
        lastRunAt: new Date(),
        fullyCrawled: true,
      },
    });
    return;
  }

  if (opts.reachedEnd) {
    await prisma.scraperState.update({
      where: { portal },
      data: {
        fullyCrawled: true,
        nextWindowStart: 1,
        lastPageSeen: opts.lastPageWithResults,
        lastRunAt: new Date(),
      },
    });
    logger.info(
      `✅ [${portal}] Fin de catálogo en pág. ${opts.lastPageWithResults} → próximo discovery desde 1`
    );
    return;
  }

  if (opts.lastPageWithResults >= opts.window.end) {
    const next = opts.window.end + 1;
    await prisma.scraperState.update({
      where: { portal },
      data: {
        nextWindowStart: next,
        lastPageSeen: opts.lastPageWithResults,
        lastRunAt: new Date(),
        fullyCrawled: false,
      },
    });
    logger.info(`➡️ [${portal}] Ventana completa → próxima desde página ${next} (paso ${size})`);
    return;
  }

  // Ventana incompleta (timeout / corte): seguir desde la siguiente página
  const resume = Math.max(opts.lastPageWithResults + 1, opts.window.start);
  await prisma.scraperState.update({
    where: { portal },
    data: {
      nextWindowStart: resume,
      lastPageSeen: opts.lastPageWithResults,
      lastRunAt: new Date(),
      fullyCrawled: false,
    },
  });
  logger.info(`↪️ [${portal}] Ventana incompleta → reanuda en página ${resume}`);
}
