import type {
  BenchmarkConfig,
  CustomRoutingTable,
  CustomRoutingTableResponse,
  PoolEntry,
} from '@kilocode/auto-routing-contracts';
import {
  ComplexityLabelsSchema,
  MAX_POOL_ENTRIES,
  poolEntryKey,
} from '@kilocode/auto-routing-contracts';
import {
  getRoutingCaseResultsForEntries,
  getSummariesForRuns,
  listReadyCurrentProfilesForEntries,
} from './db';
import { variantFromStorage } from './reasoning-effort';
import { buildCustomRoutingTable } from './routing-table-builder';
import { currentProfileContextFromConfig, ProfileValidationError } from './profiles';
import { catalogCandidatePrices, fetchBenchmarkModelCatalog } from './platform-models';
import caseComplexity from './datasets/case-complexity.json';

function assertUniqueEntries(entries: readonly PoolEntry[]): void {
  if (entries.length < 1 || entries.length > MAX_POOL_ENTRIES) {
    throw new ProfileValidationError(
      `entries must contain between 1 and ${MAX_POOL_ENTRIES} unique pool entries`
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = poolEntryKey(entry);
    if (seen.has(key)) {
      throw new ProfileValidationError(`Duplicate pool entry: ${key}`);
    }
    seen.add(key);
  }
}

/**
 * Assemble a sparse custom routing table for the requested exact Pool entries
 * from ready+current Benchmark profiles and their provenance-run summaries.
 * Returns `{ table: null }` when no requested entry is ready/current.
 */
export async function assembleCustomRoutingTable(
  db: D1Database,
  config: Pick<
    BenchmarkConfig,
    'deciderRepetitions' | 'minAccuracy' | 'switchCostFactor' | 'bestAccuracySwitchThreshold'
  > &
    Partial<
      Pick<
        BenchmarkConfig,
        'productionTokenProfile' | 'switchHorizonTurns' | 'lowConfidenceThreshold'
      >
    >,
  entries: readonly PoolEntry[],
  options: {
    now?: Date;
    catalogEnv?: { KILO_WEB_API_BASE_URL: string };
    fetchImpl?: typeof fetch;
  } = {}
): Promise<CustomRoutingTableResponse> {
  assertUniqueEntries(entries);
  const current = currentProfileContextFromConfig(config);
  const readyRows = await listReadyCurrentProfilesForEntries(db, current, entries);

  const readyEntries = readyRows
    .filter(
      (row): row is typeof row & { run_id: string } => row.run_id != null && row.run_id !== ''
    )
    .map(row => ({
      entry: {
        model: row.model,
        variant: variantFromStorage(row.variant),
      } satisfies PoolEntry,
      runId: row.run_id,
    }));

  if (readyEntries.length === 0) {
    return { table: null };
  }

  const runIds = [...new Set(readyEntries.map(r => r.runId))];
  const [summaries, perCaseResults] = await Promise.all([
    getSummariesForRuns(db, runIds),
    getRoutingCaseResultsForEntries(db, readyEntries),
  ]);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const prices = options.catalogEnv
    ? catalogCandidatePrices(
        await fetchBenchmarkModelCatalog(options.catalogEnv, options.fetchImpl)
      )
    : undefined;

  const table: CustomRoutingTable | null = buildCustomRoutingTable({
    generatedAt,
    minAccuracy: config.minAccuracy,
    switchCostFactor: config.switchCostFactor,
    bestAccuracySwitchThreshold: config.bestAccuracySwitchThreshold,
    productionTokenProfile: config.productionTokenProfile ?? null,
    switchHorizonTurns: config.switchHorizonTurns ?? null,
    lowConfidenceThreshold: config.lowConfidenceThreshold ?? null,
    prices,
    readyEntries,
    summaries,
    perCaseResults,
    complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
  });

  return { table };
}
