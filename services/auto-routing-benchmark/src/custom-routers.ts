import {
  ComplexityLabelsSchema,
  benchmarkPairKey,
  customRouterCandidateModel,
  customRouterEntryKey,
  customRouterEntryRef,
  resolveEffectivePolicy,
  type BenchmarkConfig,
  type BenchmarkPair,
  type CandidatePricing,
  type ClientModelPricing,
  type CustomRouterBenchmarkContext,
  type CustomRouterEntry,
  type CustomRouterEntryStatus,
  type CustomRouterStatusResponse,
  type CustomRoutingTableResponse,
  type GatewayCustomRouterEntry,
} from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import type * as z from 'zod';
import {
  clientPairKey,
  clientProfileEntry,
  getClientRoutingCaseResults,
  groupClientProfilesByPair,
  isCurrentClientProfile,
  listOwnerClientProfiles,
  type ClientProfileRow,
} from './client-profiles';
import caseComplexity from './datasets/case-complexity.json';
import { getRoutingCaseResultsForEntries, getSummariesForRuns } from './db';
import {
  catalogCandidatePrices,
  catalogModelVariants,
  fetchBenchmarkModelCatalog,
  type BenchmarkModelCatalogSchema,
} from './platform-models';
import {
  boundFailureReason,
  buildPendingUpsertValues,
  currentProfileContextFromConfig,
  isCurrentBenchmarkProfile,
  loadProfileRowsForPairs,
  pendingStatusInsertStatement,
  type CurrentProfileContext,
  type ProfileRow,
} from './profiles';
import { variantFromStorage } from './reasoning-effort';
import { buildCustomRoutingTable } from './routing-table-builder';

type ModelCatalog = z.infer<typeof BenchmarkModelCatalogSchema>;

export type CatalogSource = {
  catalogEnv: { KILO_WEB_API_BASE_URL: string };
  fetchImpl?: typeof fetch;
};

export const CATALOG_UNAVAILABLE_FAILURE_REASON = 'Model is unavailable in the current catalog.';

/**
 * How one pool entry is measured. The owner's CLI measures every client entry and
 * each gateway entry the platform key cannot serve, under the entry's own model ID.
 * The platform measures the rest as catalog-expanded concrete pairs; a gateway
 * entry the catalog no longer lists has no pairs.
 */
export type ResolvedCustomRouterEntry =
  | { measuredBy: 'client'; entry: CustomRouterEntry; variants: (string | null)[] }
  | { measuredBy: 'platform'; entry: GatewayCustomRouterEntry; pairs: BenchmarkPair[] | null };

export async function resolveCustomRouterEntries(
  entries: readonly CustomRouterEntry[],
  clientEvalEntryKeys: readonly string[],
  source: CatalogSource
): Promise<{ resolved: ResolvedCustomRouterEntry[]; catalog: ModelCatalog | null }> {
  const catalog = entries.some(entry => entry.kind === 'gateway')
    ? await fetchBenchmarkModelCatalog(source.catalogEnv, source.fetchImpl)
    : null;
  const clientEval = new Set(clientEvalEntryKeys);
  const resolved = entries.map((entry): ResolvedCustomRouterEntry => {
    if (entry.kind === 'client') {
      return {
        measuredBy: 'client',
        entry,
        variants: entry.variants.length > 0 ? entry.variants : [null],
      };
    }
    const concrete = catalog ? catalogModelVariants(catalog, entry.model) : null;
    if (clientEval.has(customRouterEntryKey(entry))) {
      return { measuredBy: 'client', entry, variants: concrete?.variants ?? [null] };
    }
    return {
      measuredBy: 'platform',
      entry,
      pairs: concrete?.variants.map(variant => ({ model: concrete.model, variant })) ?? null,
    };
  });
  return { resolved, catalog };
}

/**
 * ADR 0005 custom-router currency: a pair serves its current-identity ready
 * measurement, otherwise its newest ready measurement from an older identity,
 * flagged stale. Platform tables never use this; they require exact identity.
 */
export function newestReadyMeasurement<T extends { status: string }>(
  rows: readonly T[],
  isCurrent: (row: T) => boolean,
  measuredAt: (row: T) => string
): { row: T; stale: boolean } | null {
  const ready = rows.filter(row => row.status === 'ready');
  const current = ready.find(isCurrent);
  if (current) return { row: current, stale: false };
  let newest: T | null = null;
  for (const row of ready) if (!newest || measuredAt(row) > measuredAt(newest)) newest = row;
  return newest ? { row: newest, stale: true } : null;
}

const platformMeasuredAt = (row: ProfileRow) => row.completed_at ?? row.updated_at;
const clientMeasuredAt = (row: ClientProfileRow) => row.updated_at;

// Client pricing is per million tokens; absent pricing means $0 (ADR 0005).
function clientCandidatePricing(pricing: ClientModelPricing | null): CandidatePricing {
  return {
    promptUsdPerToken: (pricing?.inputPerMTokUsd ?? 0) / 1_000_000,
    completionUsdPerToken: (pricing?.outputPerMTokUsd ?? 0) / 1_000_000,
    cacheReadUsdPerToken:
      pricing?.cacheReadPerMTokUsd === undefined ? null : pricing.cacheReadPerMTokUsd / 1_000_000,
  };
}

function groupPlatformRows(rows: readonly ProfileRow[]): Map<string, ProfileRow[]> {
  const byPair = new Map<string, ProfileRow[]>();
  for (const row of rows) {
    const key = benchmarkPairKey({ model: row.model, variant: variantFromStorage(row.variant) });
    const list = byPair.get(key);
    if (list) list.push(row);
    else byPair.set(key, [row]);
  }
  return byPair;
}

function platformPairs(resolved: readonly ResolvedCustomRouterEntry[]): BenchmarkPair[] {
  return resolved.flatMap(item => (item.measuredBy === 'platform' ? (item.pairs ?? []) : []));
}

type CustomRouterMeasurements = {
  current: CurrentProfileContext;
  resolved: ResolvedCustomRouterEntry[];
  catalog: ModelCatalog | null;
  platformRows: Map<string, ProfileRow[]>;
  clientRows: Map<string, ClientProfileRow[]>;
};

async function loadCustomRouterMeasurements(
  db: D1Database,
  config: BenchmarkConfig,
  context: CustomRouterBenchmarkContext,
  source: CatalogSource
): Promise<CustomRouterMeasurements> {
  const { resolved, catalog } = await resolveCustomRouterEntries(
    context.entries,
    context.clientEvalEntryKeys,
    source
  );
  const [platformRows, clientRows] = await Promise.all([
    loadProfileRowsForPairs(db, context.baseRouter, platformPairs(resolved)),
    context.clientEvalEntryKeys.length > 0
      ? listOwnerClientProfiles(db, context, context.baseRouter)
      : Promise.resolve([]),
  ]);
  return {
    current: currentProfileContextFromConfig(config),
    resolved,
    catalog,
    platformRows: groupPlatformRows(platformRows),
    clientRows: groupClientProfilesByPair(clientRows),
  };
}

/**
 * Sparse routing table for a custom router: every pool pair with a ready
 * measurement for the base router, ranked with the base router's effective
 * policy. Client entries appear as `client:<provider>/<model>` candidates.
 */
export async function assembleCustomRouterTable(
  db: D1Database,
  config: BenchmarkConfig,
  context: CustomRouterBenchmarkContext,
  source: CatalogSource & { now?: Date }
): Promise<CustomRoutingTableResponse> {
  const { current, resolved, catalog, platformRows, clientRows } =
    await loadCustomRouterMeasurements(db, config, context, source);
  const platformReady: { entry: BenchmarkPair; runId: string; stale: boolean }[] = [];
  const clientReady: { profile: ClientProfileRow; stale: boolean }[] = [];
  const prices = new Map(catalog ? catalogCandidatePrices(catalog) : []);
  for (const item of resolved) {
    if (item.measuredBy === 'platform') {
      for (const pair of item.pairs ?? []) {
        const served = newestReadyMeasurement(
          platformRows.get(benchmarkPairKey(pair)) ?? [],
          row => isCurrentBenchmarkProfile(row, current, pair),
          platformMeasuredAt
        );
        if (served?.row.run_id) {
          platformReady.push({ entry: pair, runId: served.row.run_id, stale: served.stale });
        }
      }
      continue;
    }
    const ref = customRouterEntryRef(item.entry);
    if (item.entry.kind === 'client') {
      prices.set(customRouterCandidateModel(ref), clientCandidatePricing(item.entry.pricing));
    }
    for (const variant of item.variants) {
      const served = newestReadyMeasurement(
        clientRows.get(clientPairKey(ref, variant)) ?? [],
        row => isCurrentClientProfile(row, current),
        clientMeasuredAt
      );
      if (served) clientReady.push({ profile: served.row, stale: served.stale });
    }
  }
  if (platformReady.length === 0 && clientReady.length === 0) return { table: null };

  const [platformSummaries, platformCases, clientCases] = await Promise.all([
    getSummariesForRuns(db, [...new Set(platformReady.map(r => r.runId))]),
    getRoutingCaseResultsForEntries(db, platformReady),
    getClientRoutingCaseResults(
      db,
      clientReady.map(r => r.profile)
    ),
  ]);
  // A profile's run id changes with every upload, so new results produce a new table version.
  const clientEntries = clientReady.map(({ profile, stale }) => {
    const runId = `client-profile:${profile.id}:${profile.results}`;
    return {
      ready: {
        entry: {
          model: customRouterCandidateModel(clientProfileEntry(profile)),
          variant: variantFromStorage(profile.variant),
        },
        runId,
        stale,
      },
      summaries: profile.route_summaries.map(summary => ({ ...summary, runId })),
    };
  });

  const policy = resolveEffectivePolicy(config);
  return {
    table: buildCustomRoutingTable({
      generatedAt: (source.now ?? new Date()).toISOString(),
      router: context.baseRouter,
      engineIdentity: current.engineIdentity,
      minAccuracy: Math.min(
        1,
        policy.minAccuracy +
          (context.baseRouter === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
      ),
      accuracyNoiseBand: policy.accuracyNoiseBand,
      frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
      switchCostFactor: policy.switchCostFactor,
      bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
      productionTokenProfile: policy.productionTokenProfile,
      switchHorizonTurns: policy.switchHorizonTurns,
      lowConfidenceThreshold: policy.lowConfidenceThreshold,
      prices,
      readyEntries: [...platformReady, ...clientEntries.map(c => c.ready)],
      summaries: [...platformSummaries, ...clientEntries.flatMap(c => c.summaries)],
      perCaseResults: [...platformCases, ...clientCases],
      complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
    }),
  };
}

type MeasuredStatus = Exclude<CustomRouterEntryStatus, 'missing' | 'stale'>;

function measurementStatus<T extends { status: MeasuredStatus; failure_reason: string | null }>(
  rows: readonly T[],
  isCurrent: (row: T) => boolean,
  measuredAt: (row: T) => string
): { status: CustomRouterEntryStatus; failureReason: string | null } {
  const served = newestReadyMeasurement(rows, isCurrent, measuredAt);
  if (served) return { status: served.stale ? 'stale' : 'ready', failureReason: null };
  const currentRow = rows.find(isCurrent);
  if (!currentRow) return { status: 'missing', failureReason: null };
  return {
    status: currentRow.status,
    failureReason:
      currentRow.status === 'failed' ? boundFailureReason(currentRow.failure_reason) : null,
  };
}

/**
 * Per-variant status of every pool entry. A platform-measured pair whose rows are
 * all from an older engine is re-admitted for free, as owner-pool status lookups do.
 */
export async function lookupCustomRouterStatuses(
  db: D1Database,
  config: BenchmarkConfig,
  context: CustomRouterBenchmarkContext,
  source: CatalogSource & { now?: Date }
): Promise<CustomRouterStatusResponse> {
  const { current, resolved, clientRows, ...loaded } = await loadCustomRouterMeasurements(
    db,
    config,
    context,
    source
  );
  let platformRows = loaded.platformRows;
  const staleOnly = platformPairs(resolved).filter(pair => {
    const rows = platformRows.get(benchmarkPairKey(pair)) ?? [];
    return rows.length > 0 && !rows.some(row => isCurrentBenchmarkProfile(row, current, pair));
  });
  if (staleOnly.length > 0) {
    const nowIso = (source.now ?? new Date()).toISOString();
    const orm = drizzle(db);
    await orm.batch(
      staleOnly.map(pair =>
        pendingStatusInsertStatement(orm, buildPendingUpsertValues(pair, current, nowIso))
      ) as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
    );
    platformRows = groupPlatformRows(
      await loadProfileRowsForPairs(db, context.baseRouter, platformPairs(resolved))
    );
  }

  return {
    entries: resolved.map(item => {
      const key = customRouterEntryKey(item.entry);
      if (item.measuredBy === 'client') {
        const ref = customRouterEntryRef(item.entry);
        return {
          key,
          variants: item.variants.map(variant => ({
            variant,
            ...measurementStatus(
              clientRows.get(clientPairKey(ref, variant)) ?? [],
              row => isCurrentClientProfile(row, current),
              clientMeasuredAt
            ),
          })),
        };
      }
      if (!item.pairs) {
        return {
          key,
          variants: [
            {
              variant: null,
              status: 'failed' as const,
              failureReason: CATALOG_UNAVAILABLE_FAILURE_REASON,
            },
          ],
        };
      }
      return {
        key,
        variants: item.pairs.map(pair => ({
          variant: pair.variant,
          ...measurementStatus(
            platformRows.get(benchmarkPairKey(pair)) ?? [],
            row => isCurrentBenchmarkProfile(row, current, pair),
            platformMeasuredAt
          ),
        })),
      };
    }),
  };
}
