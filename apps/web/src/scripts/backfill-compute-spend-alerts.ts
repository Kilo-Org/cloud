import '@/lib/load-env';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { backfillComputeSpendAlerts } from '@/lib/spend-alerts/compute-backfill';

async function main() {
  try {
    // The script connection uses POSTGRES_SCRIPT_URL. Verify its target before running.
    const result = await backfillComputeSpendAlerts(db);
    console.log(JSON.stringify(result));
  } finally {
    await closeAllDrizzleConnections();
  }
}

void main();
