import {
  ComplexityLabelsSchema,
  benchmarkPairKey,
  customRouterCandidateModel,
  customRouterEntryKey,
  linkedAvgCostUsd,
  resolveEffectivePolicy,
  toCustomRouterEntryRef,
  type AutoRouter,
  type BenchmarkConfig,
  type BenchmarkPair,
  type BenchmarkProfileFailure,
  type CandidatePricing,
  type ClientModelPricing,
  type CustomRouterBenchmarkContext,
  type CustomRouterBlockedModelsRequest,
  type CustomRouterBlockedModelsResponse,
  type CustomRouterAvailability,
  type CustomRouterEntry,
  type CustomRouterEntryStatus,
  type CustomRouterServingPin,
  type CustomRouterStatusResponse,
  type CustomRoutingTableResponse,
  type GatewayCustomRouterEntry,
} from '@kilocode/auto-routing-contracts';
import type * as z from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { benchmarkProfiles } from './db-schema';
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
  currentProfileContextFromConfig,
  isCurrentBenchmarkProfile,
  loadProfileRowsForPairs,
  type CurrentProfileContext,
  type ProfileRow,
} from './profiles';
import {
  parseProfileState,
  wireProfileFailure,
  type ProfileState,
  type ProfileStateRow,
} from './profile-failure';
import { loadSubscriptionSnapshot } from './subscriptions';
import { variantFromStorage } from './reasoning-effort';
import {
  ACTIVE_MEASUREMENT_REVISION,
  CLIENT_EVAL_REVISION,
  deciderCasesForRouter,
  PROBE_REVISION,
} from './measurement-revision';
import {
  dropIneligibleAgenticResults,
  dropIneligibleAgenticSummaries,
  pairsMissingProbeResults,
} from './probe/eligibility';
import {
  buildCustomRoutingTable,
  computeRegistryRoutingTableVersion,
} from './routing-table-builder';

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
  | {
      measuredBy: 'platform';
      entry: GatewayCustomRouterEntry;
      /** The concrete pairs whose measurements serve this entry (pinned target when one applies). */
      pairs: BenchmarkPair[] | null;
      /** The saved pin, when this entry has one. */
      servingPin: CustomRouterServingPin | null;
      /** True when the pin names a target the current catalog no longer lists. */
      servingFallback: boolean;
      /** The pinned concrete model while the catalog still lists it, or null when absent. */
      pinnedTarget: string | null;
      /** The concrete model the live catalog resolves this entry to now, or null when unknown. */
      currentTarget: string | null;
    };

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
      const servingPin = entry.kind === 'gateway' ? (entry.servingPin ?? null) : null;
      // A pin is a measurement of one concrete target. When that target is still listed it is what
      // the entry measures and serves; when it is gone the current alias target serves instead and
      // the status reports a fallback warning.
      const pinned = servingPin && catalog ? catalogModelVariants(catalog, servingPin.model) : null;
      const concrete =
        entry.kind === 'gateway' && catalog ? catalogModelVariants(catalog, entry.model) : null;
      const served = pinned ?? concrete;
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
        pairs: served?.variants.map(variant => ({ model: served.model, variant })) ?? null,
        servingPin,
        servingFallback: Boolean(servingPin && !pinned),
        pinnedTarget: pinned?.model ?? null,
        currentTarget: concrete?.model ?? null,
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
  const planned = deciderCasesForRouter(router, CLIENT_EVAL_REVISION).length * repetitions;
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

/** One ready row for a platform gateway entry, resolved to the candidate id it ranks under. */
type ReadyPlatformRow = {
  entry: GatewayCustomRouterEntry;
  pair: BenchmarkPair;
  runId: string;
  stale: boolean;
  candidate: string;
};

/**
 * Run ids whose provenance row proves paid-flow admission. Migration 0038 writes
 * `benchmark_runs.admission_marker` only from the Worker that owns the paid flow; every row an
 * older image wrote, including every pre-cutover measurement, has NULL. A missing run row is
 * therefore not evidence of paid admission either. This is read only for an un-pinned alias
 * whose ready measurement it must classify — never to write or derive a serving pin.
 */
async function paidAdmissionRunIds(
  db: D1Database,
  runIds: readonly string[]
): Promise<Set<string>> {
  const unique = [...new Set(runIds)];
  const admitted = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 50) {
    const chunk = unique.slice(offset, offset + 50);
    const rows = await db
      .prepare(
        `SELECT id FROM benchmark_runs
        WHERE id IN (${chunk.map(() => '?').join(', ')}) AND admission_marker IS NOT NULL`
      )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) admitted.add(row.id);
  }
  return admitted;
}

/**
 * Ready platform rows for one pool, in pool order and with source multiplicity preserved (an
 * alias and its own concrete entry stay two rows, as the deployed table recorded them).
 *
 * A saved pin always ranks under its logical pool entry, because both serving paths dispatch
 * `entry.model` or the pinned target. Without a pin, a measurement admitted before the paid flow
 * keeps the concrete target id the deployed table published, so an existing pool's artifact and
 * decision do not change on deploy. Only a measurement the paid flow admitted ranks under the
 * alias, which lets every pool's own entry find the shared result. A direct concrete entry has
 * `entry.model === pair.model`, so it never needs the admission read.
 */
async function resolveReadyPlatformRows(
  db: D1Database,
  current: CurrentProfileContext,
  resolved: readonly ResolvedCustomRouterEntry[],
  platformRows: ReadonlyMap<string, ProfileRow[]>
): Promise<ReadyPlatformRow[]> {
  const sources: (Omit<ReadyPlatformRow, 'candidate'> & { pinned: boolean })[] = [];
  for (const item of resolved) {
    if (item.measuredBy !== 'platform') continue;
    const pinned = item.servingPin !== null;
    for (const pair of item.pairs ?? []) {
      const served = newestReadyMeasurement(
        platformRows.get(benchmarkPairKey(pair)) ?? [],
        row => isCurrentBenchmarkProfile(row, current, pair),
        platformMeasuredAt
      );
      if (!served?.row.run_id) continue;
      sources.push({
        entry: item.entry,
        pair,
        runId: served.row.run_id,
        stale: served.stale,
        pinned,
      });
    }
  }
  const unPinnedAliases = sources.filter(
    source => !source.pinned && source.entry.model !== source.pair.model
  );
  const paidRunIds =
    unPinnedAliases.length > 0
      ? await paidAdmissionRunIds(
          db,
          unPinnedAliases.map(source => source.runId)
        )
      : null;
  return sources.map(({ pinned, ...source }) => ({
    ...source,
    candidate:
      !pinned && source.entry.model !== source.pair.model
        ? paidRunIds?.has(source.runId)
          ? source.entry.model
          : source.pair.model
        : source.entry.model,
  }));
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
  const servingFallback = resolved.flatMap(item =>
    item.measuredBy === 'platform' &&
    item.servingFallback &&
    item.currentTarget !== null &&
    !item.currentTarget.startsWith('~')
      ? [customRouterEntryKey(item.entry)]
      : []
  );
  const fallback = servingFallback.length > 0 ? { servingFallback } : {};
  const platformReady: {
    /** Ranked candidate, which can differ from its measured concrete pair. */
    entry: BenchmarkPair;
    /** The concrete pair whose measurement and run back it (the pinned or current alias target). */
    measured: BenchmarkPair;
    runId: string;
    stale: boolean;
  }[] = [];
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
  // Ready platform rows are resolved once, before the entry loop, so the fingerprint and the
  // table share one derivation of the candidate id.
  const platformReadyRows = await resolveReadyPlatformRows(db, current, resolved, platformRows);
  for (const ready of platformReadyRows) {
    if (ready.candidate === ready.pair.model) continue;
    // Price the candidate from the measured target, not the alias's current catalog price.
    const concretePricing = prices.get(ready.pair.model);
    if (concretePricing !== undefined) prices.set(ready.candidate, concretePricing);
  }
  for (const item of resolved) {
    if (item.measuredBy === 'platform') continue;
    const ref = toCustomRouterEntryRef(item.entry);
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
  // A saved pin dispatches its concrete target while the catalog still lists it, even with no
  // measurement yet: the serving Worker reads this map independently of `table`, so the pool's
  // default and fallback dispatch reach the pinned target before a ranked candidate exists.
  // A pin whose target left the catalog is omitted, so the live alias serves and `servingFallback`
  // warns instead.
  const servingPins = Object.fromEntries(
    resolved.flatMap(item =>
      item.measuredBy === 'platform' && item.pinnedTarget !== null
        ? [[customRouterEntryKey(item.entry), item.pinnedTarget] as const]
        : []
    )
  );
  const pinned = Object.keys(servingPins).length > 0 ? { servingPins } : {};
  // Duplicate source rows stay in `platformReady` for the version hash (the deployed artifact
  // counted an alias and its own concrete entry separately); only the emission below dedupes.
  for (const ready of platformReadyRows) {
    platformReady.push({
      entry: { model: ready.candidate, variant: ready.pair.variant },
      measured: ready.pair,
      runId: ready.runId,
      stale: ready.stale,
    });
  }

  if (platformReady.length === 0 && linkedReady.length === 0 && clientReady.length === 0) {
    return { table: null, ...fallback, ...pinned };
  }

  const measuredReadies = platformReady.map(ready => ({
    entry: ready.measured,
    runId: ready.runId,
  }));
  const [allPlatformSummaries, allPlatformCases, clientCases] = await Promise.all([
    getSummariesForRuns(db, [...new Set([...measuredReadies, ...linkedReady].map(r => r.runId))]),
    getRoutingCaseResultsForEntries(db, [...measuredReadies, ...linkedReady]),
    getClientRoutingCaseResults(
      db,
      clientReady.map(r => r.profile)
    ),
  ]);
  // Same route-scoped rule as the platform table (src/probe/eligibility.ts): a platform pair
  // whose run lacks complete probe results keeps every route the owner chose except the
  // agentic ones, and a route it alone covered is omitted from this sparse table.
  const probesActive =
    context.baseRouter === 'efficient' && ACTIVE_MEASUREMENT_REVISION >= PROBE_REVISION;
  const ineligible = probesActive
    ? await pairsMissingProbeResults(db, {
        entries: [...measuredReadies, ...linkedReady],
        revision: PROBE_REVISION,
      })
    : new Set<string>();
  const platformSummaries = dropIneligibleAgenticSummaries(allPlatformSummaries, ineligible);
  const platformCases = dropIneligibleAgenticResults(allPlatformCases, ineligible);
  // A pool holding both an alias and its concrete target resolves both to one measured pair. The
  // deployed table published that pair once (its summaries were keyed by the stored pair), so the
  // emission dedupes here — after the fingerprint above already counted both source rows.
  const emittedMeasurementKeys = new Set<string>();
  const platformEntries = platformReady.flatMap(ready => {
    const key = `${ready.entry.model}\u0000${ready.entry.variant ?? ''}\u0000${ready.runId}`;
    if (emittedMeasurementKeys.has(key)) return [];
    emittedMeasurementKeys.add(key);
    return [
      {
        summaries: platformSummaries
          .filter(
            summary =>
              summary.model === ready.measured.model &&
              (summary.variant ?? null) === ready.measured.variant &&
              summary.runId === ready.runId
          )
          .map(summary => ({ ...summary, model: ready.entry.model })),
        cases: platformCases
          .filter(
            pair => pair.model === ready.measured.model && pair.variant === ready.measured.variant
          )
          .map(pair => ({ ...pair, model: ready.entry.model })),
      },
    ];
  });
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
  const table = buildCustomRoutingTable({
    generatedAt: (source.now ?? new Date()).toISOString(),
    router: context.baseRouter,
    engineIdentity: current.engineIdentity,
    minAccuracy: Math.min(
      1,
      policy.minAccuracy + (context.baseRouter === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
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
      // Source multiplicity is part of the deployed version hash: an alias and its own concrete
      // entry counted as two ready contributors even though the table emitted one candidate.
      ...platformReady.map(ready => ({
        entry: ready.entry,
        runId: ready.runId,
        stale: ready.stale,
      })),
      ...linkedEntries.map(c => c.ready),
      ...clientEntries.map(c => c.ready),
    ],
    summaries: [
      ...platformEntries.flatMap(c => c.summaries),
      ...linkedEntries.flatMap(c => c.summaries),
      // The probe gate above covers only pairs this benchmark measured: a client-uploaded
      // profile carries the owner's own measurements, which include the agentic routes, so
      // it keeps every route it reports (src/custom-routers-probe.test.ts).
      ...clientEntries.flatMap(c => c.summaries),
    ],
    perCaseResults: [
      ...platformEntries.flatMap(c => c.cases),
      ...linkedEntries.flatMap(c => c.cases),
      ...clientCases,
    ],
    complexityLabels: ComplexityLabelsSchema.parse(caseComplexity),
  });
  return {
    table,
    ...fallback,
    ...pinned,
  };
}

/**
 * What the owner's pre-feature serving data recorded for each alias, from the global
 * `benchmark_subscriptions` snapshot the old owner queue maintained. Informational only.
 *
 * It is never adopted as a pin. That snapshot is keyed by owner and base router, not by pool, so
 * every pool of the same owner at the same difficulty shares one row; `replaceSnapshot` overwrites
 * it with the last registration batch; and `pairs` records what the alias resolved to at the last
 * sync rather than what a given pool actually ranked. It therefore cannot prove which target a
 * pool served, and picking one would invent history. A single concrete `servingPairs` model is
 * reported for display; more than one is reported as ambiguous.
 */
async function readLegacyServingTargets(
  db: D1Database,
  context: CustomRouterBenchmarkContext,
  baseRouter: BenchmarkConfig['router'],
  aliases: readonly string[]
): Promise<Map<string, { target: string | null; ambiguous: boolean }>> {
  const models = new Set(aliases);
  const result = new Map<string, { target: string | null; ambiguous: boolean }>();
  if (models.size === 0) return result;
  let snapshot: Awaited<ReturnType<typeof loadSubscriptionSnapshot>>;
  try {
    snapshot = await loadSubscriptionSnapshot(db, baseRouter, {
      ownerType: context.ownerType,
      ownerId: context.ownerId,
    });
  } catch {
    // An unreadable legacy snapshot means nothing is known; it must never fail a status answer.
    return result;
  }
  for (const entry of snapshot) {
    if (!models.has(entry.model)) continue;
    const concrete = new Set(entry.servingPairs.map(pair => pair.model));
    result.set(entry.model, {
      target: concrete.size === 1 ? ([...concrete][0] ?? null) : null,
      ambiguous: concrete.size > 1,
    });
  }
  return result;
}

type MeasuredStatus = Exclude<CustomRouterEntryStatus, 'missing' | 'stale'>;

type MeasurementStatus = {
  status: CustomRouterEntryStatus;
  failureReason: string | null;
  /** Present only for a failed row, so a ready/missing status keeps its old wire shape. */
  failure?: BenchmarkProfileFailure;
};

type MeasurementRow = { status: MeasuredStatus | 'unavailable'; failure_reason: string | null };

/**
 * The failure state of a client-measured row.
 *
 * `client_profiles` stores `status`, `failure_reason` and `updated_at` only — no attempt
 * counters, no class, no `unavailable` state (that is platform-only). Reusing the platform
 * reader put `undefined` attempt counts on the wire (NaN), so the failure is built from the
 * row's own columns: one recorded attempt at its last update, always retryable on a fresh
 * confirmation.
 */
function clientRowProfileState(row: ClientProfileRow): ProfileState {
  const lastFailedAt = row.updated_at;
  return {
    kind: 'retryable_failure',
    runId: null,
    failure: {
      failureClass: 'unknown',
      attempts: 1,
      firstFailedAt: lastFailedAt,
      lastFailedAt,
      reason: boundFailureReason(row.failure_reason),
    },
    retryAfter: lastFailedAt,
  };
}

function measurementStatus<T extends MeasurementRow>(
  rows: readonly T[],
  isCurrent: (row: T) => boolean,
  measuredAt: (row: T) => string,
  isComplete?: (row: T) => boolean,
  /**
   * How to read this row's failure state. Platform rows share the full registry shape; client
   * rows have only status/reason/updated_at, so each call site passes its own reader rather
   * than forcing one schema onto both.
   */
  failureState: (row: T) => ProfileState = row =>
    parseProfileState(row as unknown as ProfileStateRow)
): MeasurementStatus {
  const served = newestReadyMeasurement(rows, isCurrent, measuredAt, isComplete);
  if (served) return { status: served.stale ? 'stale' : 'ready', failureReason: null };
  const currentRow = rows.find(isCurrent);
  if (!currentRow) return { status: 'missing', failureReason: null };
  if (currentRow.status === 'failed' || currentRow.status === 'unavailable') {
    // Client rows carry only `status`, `failure_reason`, `updated_at`: they have no attempt
    // counters, class or timestamps. Parsing them through the platform state reader yields
    // undefined attempts (NaN on the wire), so the failure is built from what a client row
    // actually has — a single failed attempt at its own last update.
    const failure = wireProfileFailure(failureState(currentRow));
    return {
      status: 'failed',
      failureReason: boundFailureReason(currentRow.failure_reason),
      ...(failure ? { failure } : {}),
    };
  }
  return { status: currentRow.status, failureReason: null };
}

/** Measurement-side availability for one variant, before any owner billing state is folded in. */
function availabilityFor(
  status: MeasurementStatus,
  options: { pinMoved: boolean; fallback: boolean }
): CustomRouterAvailability {
  // Only a permanent verdict blocks the pool; a retryable failure is measurable again after a
  // fresh explicit confirmation and must never read as the blocking state.
  if (status.failure?.kind === 'permanent') return 'permanent_failure';
  if (status.status === 'ready') {
    // A served pin hides a moved alias: the measurement is usable, the owner may refresh it.
    return options.pinMoved ? 'alias_rebenchmark_needed' : 'ready';
  }
  if (status.status === 'stale') return 'stale';
  if (status.status === 'pending' || status.status === 'running') return 'benchmarking';
  // A retryable failure is not running; it becomes measurable again on a fresh confirmation.
  if (status.status === 'failed') return 'unbenchmarked';
  if (options.fallback) return 'alias_rebenchmark_needed';
  return 'unbenchmarked';
}

/**
 * Per-variant status of every pool entry. Read-only: a stale measurement is reported as stale and
 * never re-admitted here, because a measurement starts only from an explicit paid confirmation.
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
  const platformRows = loaded.platformRows;
  const legacy = await readLegacyServingTargets(
    db,
    context,
    context.baseRouter,
    resolved
      .filter(item => item.measuredBy === 'platform' && item.servingPin === null)
      .map(item => item.entry.model)
  );
  // Informational only: an unpinned alias reports what the old owner snapshot recorded, when it
  // names exactly one target. A pinned entry has authoritative data and reports none.
  const provenanceFor = (item: ResolvedCustomRouterEntry) => {
    if (item.measuredBy !== 'platform' || item.servingPin !== null) return {};
    const provenance = legacy.get(item.entry.model);
    return provenance
      ? { legacyServingTarget: provenance.target, legacyServingAmbiguous: provenance.ambiguous }
      : {};
  };

  return {
    entries: resolved.map(item => {
      const key = customRouterEntryKey(item.entry);
      if (item.measuredBy === 'client') {
        const ref = toCustomRouterEntryRef(item.entry);
        return {
          key,
          variants: item.variants.map(variant => {
            const linked = item.linkedVariants?.get(variant);
            const status = linked
              ? measurementStatus(
                  platformRows.get(benchmarkPairKey(linked)) ?? [],
                  row => isCurrentLinkedProfile(row, current, linked, loaded.catalog),
                  platformMeasuredAt
                )
              : measurementStatus(
                  clientRows.get(clientPairKey(ref, variant)) ?? [],
                  row => isCurrentClientProfile(row, current),
                  clientMeasuredAt,
                  clientProfileComplete(context.baseRouter, current.repetitions),
                  clientRowProfileState
                );
            return {
              variant,
              linked: Boolean(linked),
              ...status,
              availability: availabilityFor(status, { pinMoved: false, fallback: false }),
            };
          }),
        };
      }
      if (!item.pairs) {
        return {
          key,
          ...provenanceFor(item),
          variants: [
            {
              variant: null,
              linked: false,
              status: 'failed' as const,
              failureReason: CATALOG_UNAVAILABLE_FAILURE_REASON,
              failure: null,
              availability: 'unbenchmarked' as const,
            },
          ],
        };
      }
      // `servingModel` needs a ready measurement behind the pin; the dispatch target itself is
      // reported by `servingPins`, so a listed pin with no evidence stays a plain `missing` row.
      const pinUsable = Boolean(
        item.servingPin &&
        item.pairs.some(
          pair =>
            pair.model === item.servingPin?.model &&
            newestReadyMeasurement(
              platformRows.get(benchmarkPairKey(pair)) ?? [],
              row => isCurrentBenchmarkProfile(row, current, pair),
              platformMeasuredAt
            ) !== null
        )
      );
      return {
        key,
        ...provenanceFor(item),
        variants: item.pairs.map(pair => {
          const status = measurementStatus(
            platformRows.get(benchmarkPairKey(pair)) ?? [],
            row => isCurrentBenchmarkProfile(row, current, pair),
            platformMeasuredAt
          );
          return {
            variant: pair.variant,
            linked: false,
            ...(status.failure ? { failure: status.failure, resolvedModel: pair.model } : {}),
            ...(!status.failure && pinUsable && item.servingPin
              ? { servingModel: item.servingPin.model }
              : {}),
            ...(item.servingFallback ? { servingFallback: true } : {}),
            ...status,
            availability: availabilityFor(status, {
              pinMoved: Boolean(
                pinUsable &&
                item.servingPin &&
                item.currentTarget !== null &&
                item.currentTarget !== item.servingPin.model
              ),
              fallback: item.servingFallback,
            }),
          };
        }),
      };
    }),
  };
}

/**
 * Readiness fingerprint for one pool's table, computed without building it: the ready contributor
 * identity the table ranks (logical candidate + variant + measuring run id), plus the knobs that
 * decide whether a candidate competes at all. The serving Worker probes it before rebuilding, so a
 * newly ready measurement — from any payer — invalidates its cache within seconds instead of after
 * the TTL, at the cost of one indexed profile read per context.
 *
 * It reads only the rows the entries already resolve to; it never admits, writes or changes
 * ranking. It is not the table's `version` (that also hashes prices and summaries), so a matching
 * fingerprint means "the ready set a pool ranks is unchanged", never "the built table is identical".
 */
export async function computeCustomRouterReadinessVersion(
  db: D1Database,
  config: BenchmarkConfig,
  context: CustomRouterBenchmarkContext,
  source: CatalogSource
): Promise<string> {
  const { current, resolved, platformRows } = await loadCustomRouterMeasurements(
    db,
    config,
    context,
    source
  );
  // Same candidate ids and source multiplicity the table's own version hash counts, so a
  // fingerprint match means the ranked set is unchanged.
  const contributors = (await resolveReadyPlatformRows(db, current, resolved, platformRows)).map(
    ready => ({ runId: ready.runId, model: ready.candidate, variant: ready.pair.variant })
  );
  const policy = resolveEffectivePolicy(config);
  return computeRegistryRoutingTableVersion(contributors, {
    router: context.baseRouter,
    engineIdentity: current.engineIdentity,
    minAccuracy: Math.min(
      1,
      policy.minAccuracy + (context.baseRouter === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
    ),
    accuracyNoiseBand: policy.accuracyNoiseBand,
    frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: policy.productionTokenProfile,
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
  });
}

/**
 * Read-only add-time check for the pool editor: resolve each asked model (an alias included) to the
 * exact gateway pairs at the live base router and report the pairs whose registry row is
 * permanently unavailable. It reads the registry only: it never writes a pending row, never admits
 * a benchmark and never spends.
 *
 * Deliberately broader than `listCurrentFailedProfiles` on two axes, both of which would otherwise
 * hide a real verdict from the editor:
 * - every repetition count at the live engine identity, because permanence is a property of the
 *   model (unsupported tool use, delisted, context too small), not of how many repetitions a run
 *   happened to use; and
 * - every queue flag, because a row's `user_requested`/`platform_requested` flags say who last
 *   wanted it, not whether the model can be measured.
 * It stays on the live engine identity: an engine bump is a new measurement regime, so an older
 * engine's terminal verdict no longer proves anything about the pair that would be measured now.
 */
export async function lookupCustomRouterBlockers(
  db: D1Database,
  config: BenchmarkConfig,
  request: CustomRouterBlockedModelsRequest,
  source: CatalogSource
): Promise<CustomRouterBlockedModelsResponse> {
  const catalog = await fetchBenchmarkModelCatalog(source.catalogEnv, source.fetchImpl);
  const current = currentProfileContextFromConfig(config);
  const rows = await drizzle(db)
    .select()
    .from(benchmarkProfiles)
    .where(
      and(
        inArray(benchmarkProfiles.status, ['failed', 'unavailable']),
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity)
      )
    )
    .orderBy(asc(benchmarkProfiles.model), asc(benchmarkProfiles.variant));
  const permanent = new Map<
    string,
    { model: string; variant: string | null; failure: BenchmarkProfileFailure }
  >();
  for (const row of rows) {
    const failure = wireProfileFailure(parseProfileState(row));
    if (failure?.kind !== 'permanent') continue;
    const variant = variantFromStorage(row.variant);
    const key = benchmarkPairKey({ model: row.model, variant });
    // One verdict per pair: the first row wins, so the order stays deterministic.
    if (!permanent.has(key)) permanent.set(key, { model: row.model, variant, failure });
  }
  const failedPairs = [...permanent.values()];
  const blocked = request.models.flatMap(model => {
    const concrete = catalogModelVariants(catalog, model);
    if (!concrete) return [];
    return concrete.variants.flatMap(variant => {
      const match = failedPairs.find(
        entry => entry.model === concrete.model && entry.variant === variant
      );
      return match
        ? [
            {
              model,
              pair: { model: concrete.model, variant },
              failure: match.failure,
            },
          ]
        : [];
    });
  });
  return { router: request.router, blocked };
}
