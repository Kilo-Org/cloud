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
    // The identity ends with a hash of the dataset contents. A different hash
    // means the dataset changed after the run started, so the current dataset's
    // length is not this run's length. An engine-version bump alone keeps the
    // dataset, so the total stays known.
    const datasetChanged =
      datasetHashOf(row.engineIdentity) !==
      datasetHashOf(computeEngineIdentity(row.kind, row.router));
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

function datasetHashOf(engineIdentity: string): string {
  return engineIdentity.slice(engineIdentity.lastIndexOf(':') + 1);
}
