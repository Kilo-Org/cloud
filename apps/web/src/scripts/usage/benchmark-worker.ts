import { parentPort, workerData } from 'worker_threads';
import { insertUsageRecord } from '@/lib/processUsage';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import { closeAllDrizzleConnections } from '@/lib/drizzle';
import type { UsageMetaData } from '@/lib/processUsage.types';

type RecordPair = { core: MicrodollarUsage; metadata: UsageMetaData };

const { records, workerId } = workerData as {
  records: RecordPair[];
  workerId: number;
};

async function run() {
  let inserted = 0;
  const batchSize = 1000;
  const startTime = performance.now();

  for (const { core, metadata } of records) {
    await insertUsageRecord(core, metadata);
    inserted++;

    if (inserted % batchSize === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      const rate = inserted / elapsed;
      parentPort?.postMessage({
        type: 'progress',
        workerId,
        inserted,
        total: records.length,
        rate: rate.toFixed(1),
      });
    }
  }

  const elapsedMs = performance.now() - startTime;

  await closeAllDrizzleConnections();

  parentPort?.postMessage({
    type: 'done',
    workerId,
    inserted,
    elapsedMs,
  });
}

run().catch(err => {
  parentPort?.postMessage({ type: 'error', workerId, error: err.message });
  process.exit(1);
});
