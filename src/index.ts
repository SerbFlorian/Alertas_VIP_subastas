import 'dotenv/config';
import './services/redacted-console';
import cron from 'node-cron';
import express from 'express';

import { prisma } from './db/prisma';
import { initRedis, disconnectRedis } from './db/redis';
import { ejecutarScraperJob } from './jobs/scraper.job';
import { ejecutarMatchingJob, ejecutarCanalPublicoJob, PUBLIC_CHANNEL_CRON, PUBLIC_CHANNEL_TZ } from './jobs/notifier.job';
import { ejecutarQueueFlushJob, procesarWarmupsDue } from './jobs/queue-flush.job';
import { iniciarBot, detenerBot } from './bot/telegram.bot';
import { crearStripeRouter } from './webhooks/stripe.webhook';
import { ejecutarVerificacionEnlacesJob, ejecutarLimpiezaFisicaJob } from './jobs/cleanup.job';
import { ejecutarBackupJob } from './jobs/backup.job';
import { ejecutarOpsReminderJob } from './jobs/ops-reminder.job';
import { ejecutarTitleCleanupJob, countPendingTitleCleanup } from './jobs/title-cleanup.job';
import { sendCriticalAlert } from './services/alert.service';
import { logger } from './services/logger';
import { getAppRole, runsAppWorkload, runsScraperWorkload } from './utils/app-role';

// ============================================================
// ENTRY POINT — Alertas VIP Subastas
// APP_ROLE=app | scraper | all (default)
// ============================================================

let scraperRunning = false;
let matchingRunning = false;
let publicoRunning = false;
let flushRunning = false;
let warmupRunning = false;
let titleCleanupRunning = false;

async function main(): Promise<void> {
  const role = getAppRole();
  logger.info('');
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║   🚨  Alertas VIP Subastas Bot           ║');
  logger.info('╚══════════════════════════════════════════╝');
  logger.info(`APP_ROLE=${role}`);
  logger.info('');

  await prisma.$connect();
  logger.info('✅ PostgreSQL (Prisma) listo');

  await initRedis();
  logger.info('✅ Redis init');

  if (runsAppWorkload()) {
    await startAppServerAndBot();
    scheduleAppJobs();
    // Contador VIP en chat admin (crea/edita la cajita)
    setTimeout(() => {
      import('./services/vip-counter.service')
        .then(({ refreshVipCounter }) => refreshVipCounter())
        .catch(() => {});
    }, 12_000);
  }

  if (runsScraperWorkload()) {
    scheduleScraperJobs();
  }

  logger.info('✅ Sistema activo.');
}

async function startAppServerAndBot(): Promise<void> {
  const app = express();
  const port = parseInt(process.env['PORT'] ?? '3002', 10);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Health mínimo — sin redis / memoria / jobs (superficie reducida)
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/webhook/stripe', crearStripeRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      logger.error('❌ Express error:', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  app.listen(port, '0.0.0.0', () => {
    logger.info(`🌐 Express en 0.0.0.0:${port} (host bind vía compose 127.0.0.1)`);
  });

  try {
    iniciarBot().catch((error) => logger.error('❌ Error asíncrono bot:', { error }));
  } catch (error) {
    logger.error('❌ Error iniciando bot:', { error });
  }
}

function scheduleAppJobs(): void {
  // Matching VIP → cola Redis (todos los días; reseed cubre fin de semana sin scrape)
  const matchingInterval = process.env['MATCHING_INTERVAL_MINUTES'] ?? '30';
  const matchingCronExpr =
    matchingInterval === '30' ? '15,45 7-23 * * *' : `*/${matchingInterval} 7-23 * * *`;
  cron.schedule(
    matchingCronExpr,
    async () => {
      if (matchingRunning) return;
      matchingRunning = true;
      try {
        await ejecutarMatchingJob();
      } catch (error) {
        logger.error('❌ Matching cron:', { error });
      } finally {
        matchingRunning = false;
      }
    },
    { timezone: 'Europe/Madrid' }
  );
  logger.info(`⏰ Matching VIP: cada ${matchingInterval} min · 07–23 Madrid · todos los días`);

  // Canal gratuito FOMO: fijo todos los días a las 10:00 Europe/Madrid
  cron.schedule(
    PUBLIC_CHANNEL_CRON,
    async () => {
      if (publicoRunning) return;
      publicoRunning = true;
      try {
        await ejecutarCanalPublicoJob();
      } catch (error) {
        logger.error('❌ Canal público cron:', { error });
      } finally {
        publicoRunning = false;
      }
    },
    { timezone: PUBLIC_CHANNEL_TZ }
  );
  logger.info(`⏰ Canal público FOMO: ${PUBLIC_CHANNEL_CRON} (${PUBLIC_CHANNEL_TZ}) — 1×/día`);

  // Digests VIP: tick en hard floor; ventana/cadencia reales POR USUARIO (/horario)
  const hardStart = Math.max(0, parseInt(process.env['NOTIF_HARD_START_HOUR'] ?? '7', 10));
  const hardEnd = Math.min(23, parseInt(process.env['NOTIF_HARD_END_HOUR'] ?? '23', 10));
  // Cron hour range is inclusive end → last tick hour = hardEnd - 1 (end exclusive)
  const digestHourCron =
    hardEnd > hardStart + 1 ? `${hardStart}-${hardEnd - 1}` : `${hardStart}`;
  const tickMins = Math.min(
    5,
    Math.max(1, parseInt(process.env['NOTIFIER_TICK_MINUTES'] ?? '5', 10))
  );
  const flushCronExpr = `*/${tickMins} ${digestHourCron} * * *`;
  cron.schedule(
    flushCronExpr,
    async () => {
      if (flushRunning) return;
      flushRunning = true;
      try {
        await ejecutarQueueFlushJob();
      } catch (error) {
        logger.error('❌ Queue flush:', { error });
      } finally {
        flushRunning = false;
      }
    },
    { timezone: 'Europe/Madrid' }
  );
  logger.info(
    `⏰ Digests VIP: tick cada ${tickMins} min · hard floor ${hardStart}–${hardEnd} Madrid · cadencia vía /horario (${flushCronExpr})`
  );

  // Warmup: primer lote 5–15 min tras Aplicar (cuota 24 h solo si envía)
  cron.schedule(
    '* * * * *',
    async () => {
      if (warmupRunning) return;
      warmupRunning = true;
      try {
        await procesarWarmupsDue();
      } catch (error) {
        logger.error('❌ Warmup cron:', { error });
      } finally {
        warmupRunning = false;
      }
    },
    { timezone: 'Europe/Madrid' }
  );
  logger.info(
    `⏰ Warmup digest: cada 1 min · ${process.env['DIGEST_WARMUP_MIN_MINUTES'] ?? '5'}–${process.env['DIGEST_WARMUP_MAX_MINUTES'] ?? '15'} min · cuota ${process.env['DIGEST_WARMUP_QUOTA_HOURS'] ?? '24'} h`
  );

  // Inventory stats: solo post-scrape en contenedor scraper (evita doble trabajo)

  cron.schedule('0 2 * * 1-5', async () => {
    try {
      await ejecutarVerificacionEnlacesJob();
    } catch (error) {
      logger.error('❌ Verificación enlaces:', { error });
    }
  });

  cron.schedule('0 4 * * 1-5', async () => {
    try {
      await ejecutarLimpiezaFisicaJob();
    } catch (error) {
      logger.error('❌ Limpieza física:', { error });
    }
  });

  const backupCron = process.env['BACKUP_CRON'] ?? '0 6 * * *';
  cron.schedule(backupCron, async () => {
    try {
      await ejecutarBackupJob();
    } catch (error) {
      logger.error('❌ Backup:', { error });
    }
  });
  logger.info(`⏰ Backup R2: ${backupCron} (retención ${process.env['BACKUP_RETENTION_DAYS'] ?? '7'}d)`);

  // Recordatorio ops: deps + drill restore (día 1 de mes 09:00 por defecto)
  const opsCron = process.env['OPS_REMINDER_CRON'] ?? '0 9 1 * *';
  cron.schedule(opsCron, async () => {
    try {
      await ejecutarOpsReminderJob();
    } catch (error) {
      logger.error('❌ Ops reminder:', { error });
    }
  });
  logger.info(`⏰ Ops reminder mensual: ${opsCron}`);

  setTimeout(async () => {
    flushRunning = true;
    await ejecutarQueueFlushJob().finally(() => {
      flushRunning = false;
    });
  }, 5 * 60_000);

  // Si solo app (sin scraper en este proceso), matching inicial tras boot
  if (!runsScraperWorkload()) {
    setTimeout(async () => {
      matchingRunning = true;
      await ejecutarMatchingJob().finally(() => {
        matchingRunning = false;
      });
    }, 8000);
  }
}

function scheduleScraperJobs(): void {
  const scraperCron = process.env['SCRAPER_CRON'] ?? '0 8,14,20 * * 1-5';

  cron.schedule(scraperCron, async () => {
    if (scraperRunning) return;
    scraperRunning = true;
    try {
      await ejecutarScraperJob('all');
    } catch (error) {
      logger.error('❌ Scraper cron:', { error });
      await sendCriticalAlert(`💥 Scraper crash: ${(error as Error).message}`);
    } finally {
      scraperRunning = false;
    }
  });
  logger.info(
    `⏰ Scraper L–V 8–20h: ${scraperCron} · steadyPages=${process.env['SCRAPER_STEADY_PAGES'] ?? '5'} steadyOnly=${process.env['SCRAPER_STEADY_ONLY'] ?? 'true'}`
  );

  // Limpieza marca/modelo desde título: cada 2h, máx 2h de trabajo, solo revisado=false
  cron.schedule('15 */2 * * *', async () => {
    if (titleCleanupRunning) return;
    const pending = await countPendingTitleCleanup().catch(() => 0);
    if (pending === 0) return;
    titleCleanupRunning = true;
    try {
      await ejecutarTitleCleanupJob();
    } catch (error) {
      logger.error('❌ Title cleanup cron:', { error });
    } finally {
      titleCleanupRunning = false;
    }
  });
  logger.info('⏰ Title cleanup: cada 2h (solo si hay vehiculos.revisado=false)');

  setTimeout(async () => {
    scraperRunning = true;
    await ejecutarScraperJob('all').finally(() => {
      scraperRunning = false;
    });

    if (runsAppWorkload()) {
      matchingRunning = true;
      await ejecutarMatchingJob().finally(() => {
        matchingRunning = false;
      });
    }
  }, 3000);
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`⛔ ${signal}. Apagando...`);
  if (runsAppWorkload()) {
    await detenerBot();
  }
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('💥 Error no capturado:', { error: error.message, stack: error.stack });
  sendCriticalAlert(`💥 Error fatal no capturado: ${error.message}`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  logger.error('💥 Promise rechazada:', { reason });
  sendCriticalAlert(`💥 Promise rechazada: ${String(reason)}`).catch(() => {});
});

main().catch(async (error) => {
  logger.error('💥 Error fatal:', error);
  await sendCriticalAlert(`💥 Startup failure: ${(error as Error).message}`).catch(() => {});
  process.exit(1);
});
