import { refreshInventoryStats } from '../services/inventory.service';
import { logger } from '../services/logger';

export async function ejecutarInventoryStatsJob(): Promise<void> {
  try {
    await refreshInventoryStats();
  } catch (error) {
    logger.error(`❌ InventoryStats: ${(error as Error).message}`);
    throw error;
  }
}

if (require.main === module) {
  ejecutarInventoryStatsJob()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
