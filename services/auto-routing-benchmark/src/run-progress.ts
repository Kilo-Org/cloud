import type { BenchmarkRunProgress } from '@kilocode/auto-routing-contracts';
import { listRunProgressCounts } from './db';
import { computeEngineIdentity, expectedCaseCount } from './run';

/**
 * Live progress for every RUNNING run among `runIds`, keyed by run id. Terminal
 * runs are absent: their counts are already final in their summaries.
 */
export async function loadRunProgress(
  db: D1Database,
  runIds: readonly string[]
): Promise<Map<string, BenchmarkRunProgress>> {
  const rows = await listRunProgressCounts(db, runIds);
  const progress = new Map<string, BenchmarkRunProgress>();
  for (const row of rows) {
    // The stored engine identity hashes the dataset contents. A mismatch means
    // the dataset changed after the run started (mid-rollout), so the current
    // dataset's length is not this run's length — report no total rather than a
    // number that would leave the bar short of (or past) 100%.
    const datasetChanged = row.engineIdentity !== computeEngineIdentity(row.kind, row.router);
    progress.set(row.runId, {
      completedCases: row.completedCases,
      totalCases: datasetChanged
        ? null
        : row.enqueuedModels * expectedCaseCount(row.kind, row.router) * row.repetitions,
      failedCases: row.failedCases,
    });
  }
  return progress;
}
