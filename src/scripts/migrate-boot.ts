import { execFileSync } from 'child_process';
import { prisma } from '../db/prisma';
import { logger } from '../services/logger';

// ============================================================
// Boot migrations — migrate deploy + baseline para DBs legacy (db push)
// ============================================================

const BASELINE = '20260804180000_baseline';

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS "exists"`;
  return Boolean(rows[0]?.exists);
}

async function migrationCount(): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM "_prisma_migrations"`;
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

function runPrisma(args: string[]): void {
  execFileSync('npx', ['prisma', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
}

async function main(): Promise<void> {
  await prisma.$connect();

  const hasSchema = await tableExists('vehiculos');
  const migCount = await migrationCount();

  if (hasSchema && migCount === 0) {
    logger.info(`▶ DB legacy (db push) → baseline ${BASELINE}`);
    runPrisma(['migrate', 'resolve', '--applied', BASELINE]);
  }

  logger.info('▶ prisma migrate deploy');
  runPrisma(['migrate', 'deploy']);
  logger.info('✅ Migraciones aplicadas');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  logger.error('❌ migrate-boot falló', { error: (e as Error).message });
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
