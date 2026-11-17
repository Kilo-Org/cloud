import type {
  AutoRouter,
  BenchmarkPair,
  CustomRoutingTable,
  CustomRoutingTableResponse,
  PolicySettingSource,
} from '@kilocode/auto-routing-contracts';
import {
  ComplexityLabelsSchema,
  MAX_POOL_ENTRIES,
  benchmarkPairKey,
  resolveEffectivePolicy,
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

function assertUniqueEntries(entries: readonly BenchmarkPair[]): void {
  if (entries.length < 1 || new Set(entries.map(entry => entry.model)).size > MAX_POOL_ENTRIES) {
    throw new ProfileValidationError(
      `entries must contain between 1 and ${MAX_POOL_ENTRIES} unique pool models`
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = benchmarkPairKey(entry);
    if (seen.has(key)) {
      throw new ProfileValidationError(`Duplicate pool entry: ${key}`);
    }
    seen.add(key);
  }
}

/**
 * Assemble a sparse custom routing table for expanded model-effort pairs
 * from ready+current Benchmark profiles and their provenance-run summaries.
 * Returns `{ table: null }` when no requested entry is ready/current.
 */
export async function assembleCustomRoutingTable(
  db: D1Database,
  config: PolicySettingSource & { router?: AutoRouter },
  entries: readonly BenchmarkPair[],
  options: {
    now?: Date;
    catalogEnv?: { KILO_WEB_API_BASE_URL: string };
    fetchImpl?: typeof fetch;
  } = {}
): Promise<CustomRoutingTableResponse> {
  assertUniqueEntries(entries);
  const policy = resolveEffectivePolicy(config);
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
      } satisfies BenchmarkPair,
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
    minAccuracy: policy.minAccuracy,
    accuracyNoiseBand: policy.accuracyNoiseBand,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: policy.productionTokenProfile,
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
    prices,
    readyEntries,
    summaries,
    perCaseResults,
    complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
  });

  return { table };
}
