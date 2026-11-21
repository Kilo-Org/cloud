import type { BenchmarkModelTotals, BenchmarkRunTotals } from '@kilocode/auto-routing-contracts';
import { listRunModelTotals, listRunTotals, type RunModelTotalsRow } from './db';
import { variantFromStorage } from './reasoning-effort';

/**
 * Cost and case tallies for every run among `runIds`, keyed by run id. A run
 * with no graded case is absent; a run whose cases reported no cost carries a
 * null total rather than a made-up zero.
 */
export async function loadRunTotals(
  db: D1Database,
  runIds: readonly string[]
): Promise<Map<string, BenchmarkRunTotals>> {
  const rows = await listRunTotals(db, runIds);
  return new Map(
    rows.map(row => [
      row.runId,
      {
        totalCostUsd: row.totalCostUsd,
        measuredCases: row.measuredCases,
        erroredCases: row.erroredCases,
      },
    ])
  );
}

/** Per-pair accuracy and cost means behind the route rows, for one run. */
export async function loadRunModelTotals(
  db: D1Database,
  runId: string
): Promise<BenchmarkModelTotals[]> {
  return (await listRunModelTotals(db, runId)).map(modelTotalsFromRow).toSorted(compareTotals);
}

function modelTotalsFromRow(row: RunModelTotalsRow): BenchmarkModelTotals {
  return {
    model: row.model,
    variant: variantFromStorage(row.variant),
    // Same 4 dp rounding as the persisted route summaries.
    accuracy: row.cases > 0 ? Number((row.scoreSum / row.cases).toFixed(4)) : 0,
    routeAccuracy:
      row.routeGraded > 0 ? Number((row.routeHits / row.routeGraded).toFixed(4)) : null,
    // Averaged over the cases that reported a cost, as a route summary is: a
    // case without a cost is unknown, not free.
    costPerCaseUsd:
      row.costSum === null ? null : Number((row.costSum / row.costedCases).toFixed(8)),
    totalCostUsd: row.costSum === null ? null : Number(row.costSum.toFixed(8)),
    cases: row.cases,
    // The mean and the total cover the costed cases only; the console states
    // how many cases were left out rather than extrapolating a cost for them.
    uncostedCases: row.cases - row.costedCases,
    errors: row.errors,
    timeouts: row.timeouts,
  };
}

/** Most accurate first, then the cheaper pair — the order a reader picks in. */
function compareTotals(a: BenchmarkModelTotals, b: BenchmarkModelTotals): number {
  if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
  const costA = a.costPerCaseUsd ?? Number.POSITIVE_INFINITY;
  const costB = b.costPerCaseUsd ?? Number.POSITIVE_INFINITY;
  if (costA !== costB) return costA - costB;
  return `${a.model} ${a.variant ?? ''}`.localeCompare(`${b.model} ${b.variant ?? ''}`);
}
