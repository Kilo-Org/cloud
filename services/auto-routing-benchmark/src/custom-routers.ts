import {
  ComplexityLabelsSchema,
  benchmarkPairKey,
  customRouterCandidateModel,
  customRouterEntryKey,
  customRouterEntryRef,
  linkedAvgCostUsd,
  resolveEffectivePolicy,
  type AutoRouter,
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
import { deciderCasesForRouter } from './run';
import { buildCustomRoutingTable, filterSummariesByProvenance } from './routing-table-builder';

type ModelCatalog = z.infer<typeof BenchmarkModelCatalogSchema>;

export type CatalogSource = {
  catalogEnv: { KILO_WEB_API_BASE_URL: string };
  fetchImpl?: typeof fetch;
};

export const CATALOG_UNAVAILABLE_FAILURE_REASON = 'Model is unavailable in the current catalog.';

export type ResolvedCustomRouterEntry =
  | {
      measuredBy: 'client';
      entry: CustomRouterEntry;
      variants: (string | null)[];
      linkedVariants?: Map<string | null, BenchmarkPair>;
    }
  | { measuredBy: 'platform'; entry: GatewayCustomRouterEntry; pairs: BenchmarkPair[] | null };

export async function resolveCustomRouterEntries(
  entries: readonly CustomRouterEntry[],
  clientEvalEntryKeys: readonly string[],
  source: CatalogSource,
  profiles: { db: D1Database; router: AutoRouter }
): Promise<{ resolved: ResolvedCustomRouterEntry[]; catalog: ModelCatalog | null }> {
  const catalog = entries.some(entry => entry.kind === 'gateway')
    ? await fetchBenchmarkModelCatalog(source.catalogEnv, source.fetchImpl)
    : null;
  const clientEval = new Set(clientEvalEntryKeys);
  const resolved = await Promise.all(
    entries.map(async (entry): Promise<ResolvedCustomRouterEntry> => {
      const concrete =
        entry.kind === 'gateway' && catalog ? catalogModelVariants(catalog, entry.model) : null;
      if (entry.kind === 'client' || clientEval.has(customRouterEntryKey(entry))) {
        const variants =
          entry.kind === 'client'
            ? entry.variants.length > 0
              ? entry.variants
              : [null]
            : (concrete?.variants ?? [null]);
        const measuredAs = entry.measuredAs;
        if (!measuredAs) return { measuredBy: 'client', entry, variants };
        // Same-name variants link only when the platform has measured them: the catalog lists
        // variants it has not benchmarked yet, and those stay on the owner's client eval.
        const measuredRows = await loadProfileRowsForPairs(
          profiles.db,
          profiles.router,
          variants.map(variant => ({ model: measuredAs, variant }))
        );
        const linkedVariants = new Map(
          variants
            .filter(variant =>
              measuredRows.some(
                row =>
                  row.status === 'ready' &&
                  row.run_id !== null &&
                  variantFromStorage(row.variant) === variant
              )
            )
            .map(variant => [variant, { model: measuredAs, variant }] as const)
        );
        return { measuredBy: 'client', entry, variants, linkedVariants };
      }
      return {
        measuredBy: 'platform',
        entry,
        pairs: concrete?.variants.map(variant => ({ model: concrete.model, variant })) ?? null,
      };
    })
  );
  return { resolved, catalog };
}

/**
 * ADR 0005 custom-router currency: a pair serves its current-identity ready
 * measurement, otherwise its newest ready measurement from an older identity,
 * flagged stale. A current measurement that does not yet cover every planned case
 * (a client eval in progress) yields to a stale one, so the entry keeps the routes the
 * new measurement has not reached; with no stale one, the partial current one serves.
 * Platform tables never use this; they require exact identity.
 */
export function newestReadyMeasurement<T extends { status: string }>(
  rows: readonly T[],
  isCurrent: (row: T) => boolean,
  measuredAt: (row: T) => string,
  isComplete: (row: T) => boolean = () => true
): { row: T; stale: boolean } | null {
  const ready = rows.filter(row => row.status === 'ready');
  const current = ready.find(isCurrent);
  if (current && isComplete(current)) return { row: current, stale: false };
  let newest: T | null = null;
  for (const row of ready) {
    if (isCurrent(row)) continue;
    if (!newest || measuredAt(row) > measuredAt(newest)) newest = row;
  }
  if (newest) return { row: newest, stale: true };
  return current ? { row: current, stale: false } : null;
}

const platformMeasuredAt = (row: ProfileRow) => row.completed_at ?? row.updated_at;
const clientMeasuredAt = (row: ClientProfileRow) => row.updated_at;

function clientProfileComplete(router: AutoRouter, repetitions: number) {
  const planned = deciderCasesForRouter(router).length * repetitions;
  return (row: ClientProfileRow) => row.results >= planned;
}

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
  return resolved.flatMap(item =>
    item.measuredBy === 'platform' ? (item.pairs ?? []) : [...(item.linkedVariants?.values() ?? [])]
  );
}

function isCurrentLinkedProfile(
  row: ProfileRow,
  current: CurrentProfileContext,
  pair: BenchmarkPair,
  catalog: ModelCatalog | null
): boolean {
  return (
    Boolean(
      catalog && catalogModelVariants(catalog, pair.model)?.variants.includes(pair.variant)
    ) && isCurrentBenchmarkProfile(row, current, pair)
  );
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
  const resolution = await resolveCustomRouterEntries(
    context.entries,
    context.clientEvalEntryKeys,
    source,
    { db, router: context.baseRouter }
  );
  // Linked client entries price and age their platform rows against the catalog; plans and
  // uploads never read it, so only tables and status pay for the fetch.
  const catalog =
    resolution.catalog ??
    (context.entries.some(entry => entry.measuredAs)
      ? await fetchBenchmarkModelCatalog(source.catalogEnv, source.fetchImpl)
      : null);
  const resolved = resolution.resolved;
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
  const linkedReady: {
    entry: BenchmarkPair;
    runId: string;
    stale: boolean;
    candidate: string;
    ownerPricing: CandidatePricing | null;
    platformPricing: CandidatePricing | null;
  }[] = [];
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
    const candidate = customRouterCandidateModel(ref);
    const ownerPricing =
      item.entry.kind === 'client'
        ? item.entry.pricing === null
          ? null
          : clientCandidatePricing(item.entry.pricing)
        : (prices.get(item.entry.model) ?? null);
    if (item.entry.kind === 'client') {
      prices.set(candidate, clientCandidatePricing(item.entry.pricing));
    }
    for (const variant of item.variants) {
      const linked = item.linkedVariants?.get(variant);
      if (linked) {
        if (item.entry.kind === 'gateway' && ownerPricing === null) continue;
        const served = newestReadyMeasurement(
          platformRows.get(benchmarkPairKey(linked)) ?? [],
          row => isCurrentLinkedProfile(row, current, linked, catalog),
          platformMeasuredAt
        );
        if (served?.row.run_id) {
          linkedReady.push({
            entry: linked,
            runId: served.row.run_id,
            stale: served.stale,
            candidate,
            ownerPricing,
            platformPricing: prices.get(linked.model) ?? null,
          });
        }
        continue;
      }
      const served = newestReadyMeasurement(
        clientRows.get(clientPairKey(ref, variant)) ?? [],
        row => isCurrentClientProfile(row, current),
        clientMeasuredAt,
        clientProfileComplete(context.baseRouter, current.repetitions)
      );
      if (served) clientReady.push({ profile: served.row, stale: served.stale });
    }
  }
  if (platformReady.length === 0 && linkedReady.length === 0 && clientReady.length === 0) {
    return { table: null };
  }

  const [platformSummaries, platformCases, clientCases] = await Promise.all([
    getSummariesForRuns(db, [...new Set([...platformReady, ...linkedReady].map(r => r.runId))]),
    getRoutingCaseResultsForEntries(db, [...platformReady, ...linkedReady]),
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
  const linkedEntries = linkedReady.map(linked => ({
    ready: {
      entry: { model: linked.candidate, variant: linked.entry.variant },
      runId: linked.runId,
      stale: linked.stale,
    },
    summaries: platformSummaries.flatMap(summary => {
      if (
        summary.model !== linked.entry.model ||
        (summary.variant ?? null) !== linked.entry.variant ||
        summary.runId !== linked.runId
      )
        return [];
      const avgCostUsd = linkedAvgCostUsd(summary, linked.ownerPricing, linked.platformPricing);
      return avgCostUsd === null ? [] : [{ ...summary, model: linked.candidate, avgCostUsd }];
    }),
    cases: platformCases
      .filter(pair => pair.model === linked.entry.model && pair.variant === linked.entry.variant)
      .map(pair => ({ ...pair, model: linked.candidate })),
  }));

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
      readyEntries: [
        ...platformReady,
        ...linkedEntries.map(c => c.ready),
        ...clientEntries.map(c => c.ready),
      ],
      summaries: [
        ...filterSummariesByProvenance(platformReady, platformSummaries),
        ...linkedEntries.flatMap(c => c.summaries),
        ...clientEntries.flatMap(c => c.summaries),
      ],
      perCaseResults: [
        ...platformCases.filter(pair =>
          platformReady.some(ready => benchmarkPairKey(ready.entry) === benchmarkPairKey(pair))
        ),
        ...linkedEntries.flatMap(c => c.cases),
        ...clientCases,
      ],
      complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
    }),
  };
}

type MeasuredStatus = Exclude<CustomRouterEntryStatus, 'missing' | 'stale'>;

function measurementStatus<T extends { status: MeasuredStatus; failure_reason: string | null }>(
  rows: readonly T[],
  isCurrent: (row: T) => boolean,
  measuredAt: (row: T) => string,
  isComplete?: (row: T) => boolean
): { status: CustomRouterEntryStatus; failureReason: string | null } {
  const served = newestReadyMeasurement(rows, isCurrent, measuredAt, isComplete);
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
  const staleOnly = resolved
    .flatMap(item => (item.measuredBy === 'platform' ? (item.pairs ?? []) : []))
    .filter(pair => {
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
          variants: item.variants.map(variant => {
            const linked = item.linkedVariants?.get(variant);
            return {
              variant,
              linked: Boolean(linked),
              ...(linked
                ? measurementStatus(
                    platformRows.get(benchmarkPairKey(linked)) ?? [],
                    row => isCurrentLinkedProfile(row, current, linked, loaded.catalog),
                    platformMeasuredAt
                  )
                : measurementStatus(
                    clientRows.get(clientPairKey(ref, variant)) ?? [],
                    row => isCurrentClientProfile(row, current),
                    clientMeasuredAt,
                    clientProfileComplete(context.baseRouter, current.repetitions)
                  )),
            };
          }),
        };
      }
      if (!item.pairs) {
        return {
          key,
          variants: [
            {
              variant: null,
              linked: false,
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
          linked: false,
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
