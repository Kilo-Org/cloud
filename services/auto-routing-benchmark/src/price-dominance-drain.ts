import {
  benchmarkPairKey,
  rankCandidates,
  TAXONOMY_ROUTE_KEYS,
  type AutoRouter,
  type BenchmarkConfig,
  type CandidatePricing,
  type ProductionTokenProfile,
  type RankedCandidate,
  type RoutingTable,
  type TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  benchmarkPoolMemberships,
  benchmarkPriceVerdicts,
  benchmarkProfiles,
} from './db-schema';
import { getLatestRoutingTable, getSummariesForRuns } from './db';
import { buildCustomRoutingTable } from './routing-table-builder';
import {
  evaluatePriceDominance,
  pairIsMeasured,
  routeCandidates,
  type MeasurementPool,
  type MeasurementPoolKind,
  type PoolRouteInput,
  type PriceDominanceNumbers,
  type PriceDominanceVerdict,
  type RouteTokenUsage,
} from './price-dominance';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

/**
 * Price-dominance pruning at the drain (lever 1 of the benchmark cost work).
 *
 * A drain is about to measure a batch of registry pairs. Before it claims them, each pair
 * is checked route by route against EVERY pool that would be served by measuring it
 * (`src/price-dominance.ts`): the platform decider list's published table, and each owner
 * pool's own sparse table. A pair is skipped only when it cannot win on any route, in any
 * pool that includes it.
 *
 * Re-evaluation is implicit. Every skip record carries the pool's published table version
 * and the pair's catalog price; the gate trusts a stored verdict only while both still
 * match, so a publish or a price change re-opens the decision at the next drain. Nothing
 * has to invalidate rows for the rule to stay honest — this is what makes "when the leader
 * or the prices change, skipped pairs become eligible again" true without a sweep.
 */

export type SkipRecord = {
  pair: { model: string; variant: string | null };
  routeKey: TaxonomyRouteKey;
  /** The pool whose numbers the record shows: the first pool that found it dominated. */
  pool: MeasurementPool;
  numbers: PriceDominanceNumbers;
  leaderVersion: string;
  pairPriceFingerprint: string;
};

export type GateInput = {
  db: D1Database;
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
  /** Every pair the drain is about to measure. */
  pairs: readonly { model: string; variant: string | null }[];
  /** Catalog prices, as the drain already fetched them for the batch. */
  prices: ReadonlyMap<string, CandidatePricing | null>;
};

export type GateResult = {
  /** Pairs the drain may measure: everything not dominated on every route of every pool. */
  allowed: readonly { model: string; variant: string | null }[];
  skipped: readonly { model: string; variant: string | null }[];
  /** Most-row-per-pair skip records written this pass, for the drain's log line. */
  recordCount: number;
};

/** The platform decider list's own pool. */
export function platformPool(): MeasurementPool {
  return { kind: 'platform', id: 'platform' };
}

/** An owner pool's key. `kind` names the pool type only; `id` is internal. */
export function ownerPool(kind: Exclude<MeasurementPoolKind, 'platform'>, ownerId: string) {
  return { kind, id: ownerId };
}

function priceFingerprint(pricing: CandidatePricing | null | undefined): string {
  return pricing
    ? `${pricing.promptUsdPerToken}/${pricing.completionUsdPerToken}/${pricing.cacheReadUsdPerToken ?? 'null'}`
    : 'unpriced';
}

const POOL_KIND_BY_OWNER: Record<'platform' | 'user' | 'org', MeasurementPoolKind> = {
  platform: 'platform',
  user: 'user_subscription',
  org: 'custom',
};

/** The pool type a subscription's owner asks for. */
export function poolKindForOwnerType(ownerType: 'platform' | 'user' | 'org'): MeasurementPoolKind {
  return POOL_KIND_BY_OWNER[ownerType];
}

/**
 * Which pools include each pair. Platform membership comes from the registry row's own
 * `platform_requested` flag — the drain already reads those rows, so a second copy of that
 * truth would only drift. Owner membership is the `benchmark_pool_memberships` index, one
 * primary-key prefix read for the batch.
 */
async function poolsByPair(
  db: D1Database,
  router: AutoRouter,
  current: { engineIdentity: string; repetitions: number },
  pairs: readonly { model: string; variant: string | null }[]
): Promise<Map<string, MeasurementPool[]>> {
  const byPair = new Map<string, MeasurementPool[]>();
  if (pairs.length === 0) return byPair;
  const models = [...new Set(pairs.map(pair => pair.model))];
  const wanted = new Set(pairs.map(benchmarkPairKey));
  const orm = drizzle(db);

  const platformRows = await orm
    .select({ model: benchmarkProfiles.model, variant: benchmarkProfiles.variant })
    .from(benchmarkProfiles)
    .where(
      and(
        inArray(benchmarkProfiles.model, models),
        eq(benchmarkProfiles.router, router),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true)
      )
    );
  for (const row of platformRows) {
    const pair = { model: row.model, variant: variantFromStorage(row.variant) };
    if (!wanted.has(benchmarkPairKey(pair))) continue;
    const key = benchmarkPairKey(pair);
    const pools = byPair.get(key) ?? [];
    if (!pools.some(pool => pool.kind === 'platform')) pools.push(platformPool());
    byPair.set(key, pools);
  }

  const membershipRows = await orm
    .select({
      pool_kind: benchmarkPoolMemberships.pool_kind,
      pool_id: benchmarkPoolMemberships.pool_id,
      model: benchmarkPoolMemberships.model,
      variant: benchmarkPoolMemberships.variant,
    })
    .from(benchmarkPoolMemberships)
    .where(
      and(
        inArray(benchmarkPoolMemberships.model, models),
        eq(benchmarkPoolMemberships.router, router)
      )
    );
  for (const row of membershipRows) {
    if (row.pool_kind === 'platform') continue;
    const pair = { model: row.model, variant: variantFromStorage(row.variant) };
    const key = benchmarkPairKey(pair);
    if (!wanted.has(key)) continue;
    const pools = byPair.get(key) ?? [];
    if (!pools.some(pool => pool.kind === row.pool_kind && pool.id === row.pool_id))
      pools.push({ kind: row.pool_kind, id: row.pool_id });
    byPair.set(key, pools);
  }
  return byPair;
}

/** One pool's ranking inputs: its published table per router and its measured token means. */
type PoolRanking = {
  table: RoutingTable | null;
  tokenProfile: ProductionTokenProfile | null;
  tokenUsage: Map<TaxonomyRouteKey, RouteTokenUsage[]>;
};

/** Route -> the token means of every candidate the pool serves on it. */
function tokenUsageByRoute(
  table: RoutingTable | null,
  summaries: readonly {
    model: string;
    variant?: string | null;
    routeKey: string;
    avgInputTokens?: number | null;
    avgCachedInputTokens?: number | null;
    avgOutputTokens?: number | null;
    avgReasoningTokens?: number | null;
  }[]
): Map<TaxonomyRouteKey, RouteTokenUsage[]> {
  const usage = new Map<TaxonomyRouteKey, RouteTokenUsage[]>();
  if (table === null) return usage;
  for (const routeKey of TAXONOMY_ROUTE_KEYS) {
    const served = new Set(
      routeCandidates(table, routeKey).map(candidate =>
        benchmarkPairKey({ model: candidate.model, variant: candidate.variant ?? null })
      )
    );
    const rows: RouteTokenUsage[] = [];
    for (const summary of summaries) {
      if (summary.routeKey !== routeKey) continue;
      if (!served.has(benchmarkPairKey({ model: summary.model, variant: summary.variant ?? null })))
        continue;
      if (
        summary.avgInputTokens == null ||
        summary.avgCachedInputTokens == null ||
        summary.avgOutputTokens == null ||
        summary.avgReasoningTokens == null
      )
        continue;
      rows.push({
        avgInputTokens: summary.avgInputTokens,
        avgCachedInputTokens: summary.avgCachedInputTokens,
        avgOutputTokens: summary.avgOutputTokens,
        avgReasoningTokens: summary.avgReasoningTokens,
      });
    }
    if (rows.length > 0) usage.set(routeKey, rows);
  }
  return usage;
}

/**
 * The platform pool's ranking. Its published table IS the platform's leader set, and its
 * candidates carry the token profile they were priced with.
 */
async function platformRanking(db: D1Database, router: AutoRouter): Promise<PoolRanking> {
  const latest = await getLatestRoutingTable(db, router);
  const table = latest?.table ?? null;
  return {
    table,
    tokenProfile: table?.productionTokenProfile ?? null,
    tokenUsage: new Map(),
  };
}

/**
 * One owner pool's ranking, assembled with the SAME functions the custom router tables
 * use (`buildCustomRoutingTable` + `rankCandidates`), from the pool's own ready rows. That
 * is what makes "a model that cannot win on the platform can still be the only option in a
 * user's pool" true: the pool's leader is its own, not the platform's.
 */
async function ownerRanking(
  db: D1Database,
  config: BenchmarkConfig,
  router: AutoRouter,
  current: { engineIdentity: string; repetitions: number },
  pool: MeasurementPool
): Promise<PoolRanking> {
  const orm = drizzle(db);
  const members = await orm
    .select({ model: benchmarkPoolMemberships.model, variant: benchmarkPoolMemberships.variant })
    .from(benchmarkPoolMemberships)
    .where(
      and(
        eq(benchmarkPoolMemberships.router, router),
        eq(benchmarkPoolMemberships.pool_kind, pool.kind),
        eq(benchmarkPoolMemberships.pool_id, pool.id)
      )
    );
  if (members.length === 0) return { table: null, tokenProfile: null, tokenUsage: new Map() };
  const pairs = members.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
  }));
  const readyRows = await orm
    .select({
      model: benchmarkProfiles.model,
      variant: benchmarkProfiles.variant,
      run_id: benchmarkProfiles.run_id,
    })
    .from(benchmarkProfiles)
    .where(
      and(
        inArray(
          benchmarkProfiles.model,
          [...new Set(pairs.map(pair => pair.model))]
        ),
        eq(benchmarkProfiles.router, router),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.status, 'ready')
      )
    );
  const readyEntries = readyRows
    .filter((row): row is typeof row & { run_id: string } => Boolean(row.run_id))
    .filter(row =>
      pairs.some(
        pair =>
          pair.model === row.model && variantFromStorage(row.variant) === pair.variant
      )
    )
    .map(row => ({
      entry: { model: row.model, variant: variantFromStorage(row.variant) },
      runId: row.run_id,
    }));
  if (readyEntries.length === 0) return { table: null, tokenProfile: null, tokenUsage: new Map() };
  const summaries = await getSummariesForRuns(db, [
    ...new Set(readyEntries.map(entry => entry.runId)),
  ]);
  const policy = resolveEffectivePolicy(config);
  const table = buildCustomRoutingTable({
    generatedAt: new Date().toISOString(),
    router,
    engineIdentity: current.engineIdentity,
    minAccuracy: policy.minAccuracy,
    accuracyNoiseBand: policy.accuracyNoiseBand,
    frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: policy.productionTokenProfile,
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
    readyEntries,
    summaries,
  });
  return {
    table,
    tokenProfile: table?.productionTokenProfile ?? policy.productionTokenProfile,
    tokenUsage: tokenUsageByRoute(table, summaries),
  };
}

function poolRouteInputs(
  pool: MeasurementPool,
  ranking: PoolRanking
): Map<TaxonomyRouteKey, PoolRouteInput> {
  const byRoute = new Map<TaxonomyRouteKey, PoolRouteInput>();
  for (const routeKey of TAXONOMY_ROUTE_KEYS) {
    byRoute.set(routeKey, {
      pool,
      candidates: routeCandidates(ranking.table, routeKey),
      tokenProfile: ranking.tokenProfile,
      tokenUsage: ranking.tokenUsage.get(routeKey) ?? [],
    });
  }
  return byRoute;
}

/**
 * The gate the drain calls once per batch: a pure decision per (pair, route), one write of
 * the skip records, and a yes/no per pair the drain then claims normally.
 */
export async function priceDominanceGate(
  input: GateInput & { config: BenchmarkConfig }
): Promise<GateResult> {
  const nowIso = new Date().toISOString();
  const current = { engineIdentity: input.engineIdentity, repetitions: input.repetitions };
  const pools = await poolsByPair(input.db, input.router, current, input.pairs);
  const poolKeys = new Set<string>();
  for (const list of pools.values())
    for (const pool of list) poolKeys.add(`${pool.kind}\0${pool.id}`);

  const rankings = new Map<string, PoolRanking>();
  for (const key of poolKeys) {
    const [kind, id] = key.split('\0') as [MeasurementPoolKind, string];
    const pool = { kind, id };
    rankings.set(
      key,
      kind === 'platform'
        ? await platformRanking(input.db, input.router)
        : await ownerRanking(input.db, input.config, input.router, current, pool)
    );
  }

  const allowed: { model: string; variant: string | null }[] = [];
  const skipped: { model: string; variant: string | null }[] = [];
  const records: SkipRecord[] = [];
  for (const pair of input.pairs) {
    const pairPools = pools.get(benchmarkPairKey(pair)) ?? [];
    const routeInputs = pairPools.map(pool =>
      poolRouteInputs(
        pool,
        rankings.get(`${pool.kind}\0${pool.id}`) ?? {
          table: null,
          tokenProfile: null,
          tokenUsage: new Map(),
        }
      )
    );
    const verdicts: { routeKey: TaxonomyRouteKey; verdict: PriceDominanceVerdict }[] = [];
    for (const routeKey of TAXONOMY_ROUTE_KEYS) {
      const candidatePools = routeInputs
        .map(byRoute => byRoute.get(routeKey))
        .filter((pool): pool is PoolRouteInput => pool !== undefined);
      verdicts.push({
        routeKey,
        verdict: evaluatePriceDominance({
          router: input.router,
          pair: { ...pair, pricing: input.prices.get(pair.model) ?? null },
          pools: candidatePools,
          leaderRepetitions: input.repetitions,
        }),
      });
    }
    if (pairIsMeasured(verdicts)) {
      allowed.push(pair);
      continue;
    }
    skipped.push(pair);
    for (const { routeKey, verdict } of verdicts) {
      if (verdict.kind !== 'skip') continue;
      const deciding = verdict.pools[0];
      records.push({
        pair,
        routeKey,
        pool: deciding.pool,
        numbers: verdict.numbers,
        leaderVersion:
          rankings.get(`${deciding.pool.kind}\0${deciding.pool.id}`)?.table?.version ?? 'none',
        pairPriceFingerprint: priceFingerprint(input.prices.get(pair.model)),
      });
    }
  }

  await savePriceVerdicts(input, records, nowIso);
  return { allowed, skipped, recordCount: records.length };
}

/**
 * Replace the stored skip records of this batch's pairs. A pair that is now measured loses
 * its record, so the console's list is exactly the live skips.
 */
async function savePriceVerdicts(
  input: GateInput,
  records: readonly SkipRecord[],
  nowIso: string
): Promise<void> {
  const models = [...new Set(input.pairs.map(pair => pair.model))];
  if (models.length === 0) return;
  const orm = drizzle(input.db);
  const stale = await orm
    .select({
      model: benchmarkPriceVerdicts.model,
      variant: benchmarkPriceVerdicts.variant,
      route_key: benchmarkPriceVerdicts.route_key,
    })
    .from(benchmarkPriceVerdicts)
    .where(
      and(
        inArray(benchmarkPriceVerdicts.model, models),
        eq(benchmarkPriceVerdicts.router, input.router),
        eq(benchmarkPriceVerdicts.engine_identity, input.engineIdentity),
        eq(benchmarkPriceVerdicts.repetitions, input.repetitions)
      )
    );
  const kept = new Set(
    records.map(
      record => `${record.pair.model}\0${record.pair.variant ?? ''}\0${record.routeKey}`
    )
  );
  const toDelete = stale.filter(
    row => !kept.has(`${row.model}\0${variantFromStorage(row.variant)}\0${row.route_key}`)
  );
  if (toDelete.length > 0) {
    await input.db.batch(
      toDelete.map(row =>
        input.db
          .prepare(
            `DELETE FROM benchmark_price_verdicts WHERE router = ? AND model = ? AND variant = ?
             AND engine_identity = ? AND repetitions = ? AND route_key = ?`
          )
          .bind(
            input.router,
            row.model,
            row.variant,
            input.engineIdentity,
            input.repetitions,
            row.route_key
          )
      )
    );
  }
  if (records.length === 0) return;
  await input.db.batch(
    records.map(record =>
      input.db
        .prepare(
          `INSERT INTO benchmark_price_verdicts (router, model, variant, engine_identity, repetitions,
             route_key, pool_kind, pool_id, pair_request_cost_usd, leader_model, leader_variant,
             leader_request_cost_usd, leader_value, leader_accuracy, budget_usd, pair_best_value,
             leader_version, pair_price_fingerprint, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (router, model, variant, engine_identity, repetitions, route_key) DO UPDATE SET
             pool_kind = excluded.pool_kind, pool_id = excluded.pool_id,
             pair_request_cost_usd = excluded.pair_request_cost_usd,
             leader_model = excluded.leader_model, leader_variant = excluded.leader_variant,
             leader_request_cost_usd = excluded.leader_request_cost_usd,
             leader_value = excluded.leader_value, leader_accuracy = excluded.leader_accuracy,
             budget_usd = excluded.budget_usd,
             pair_best_value = excluded.pair_best_value, leader_version = excluded.leader_version,
             pair_price_fingerprint = excluded.pair_price_fingerprint,
             evaluated_at = excluded.evaluated_at`
        )
        .bind(
          input.router,
          record.pair.model,
          variantToStorage(record.pair.variant),
          input.engineIdentity,
          input.repetitions,
          record.routeKey,
          record.pool.kind,
          record.pool.id,
          record.numbers.pairRequestCostUsd,
          record.numbers.leader?.model ?? null,
          record.numbers.leader?.variant ?? null,
          record.numbers.leader?.requestCostUsd ?? null,
          record.numbers.leader?.value ?? null,
          record.numbers.leader?.accuracy ?? null,
          record.numbers.budgetUsd,
          record.numbers.pairBestValue,
          record.leaderVersion,
          record.pairPriceFingerprint,
          nowIso
        )
    )
  );
}

/**
 * Store which pools admitted a pair, so the drain's check reads an index instead of
 * scanning every owner snapshot. Called when a subscription admits pairs.
 */
export async function recordPoolMemberships(
  db: D1Database,
  router: AutoRouter,
  pool: MeasurementPool,
  pairs: readonly { model: string; variant: string | null }[]
): Promise<void> {
  if (pairs.length === 0) return;
  await db.batch(
    pairs.map(pair =>
      db
        .prepare(
          `INSERT INTO benchmark_pool_memberships (router, pool_kind, pool_id, model, variant)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
        )
        .bind(router, pool.kind, pool.id, pair.model, variantToStorage(pair.variant))
    )
  );
}

/** One live skip row, as the console's price panel shows it. */
export type PriceSkipRow = {
  model: string;
  variant: string | null;
  routeKey: string;
  poolKind: MeasurementPoolKind;
  numbers: PriceDominanceNumbers;
  evaluatedAt: string;
};

/** Live skip rows for the console, newest first. */
export async function listPriceVerdicts(
  db: D1Database,
  params: { router: AutoRouter; engineIdentity: string; repetitions: number; limit?: number }
): Promise<PriceSkipRow[]> {
  const rows = await drizzle(db)
    .select()
    .from(benchmarkPriceVerdicts)
    .where(
      and(
        eq(benchmarkPriceVerdicts.router, params.router),
        eq(benchmarkPriceVerdicts.engine_identity, params.engineIdentity),
        eq(benchmarkPriceVerdicts.repetitions, params.repetitions)
      )
    )
    .orderBy(sql`${benchmarkPriceVerdicts.evaluated_at} DESC`)
    .limit(Math.min(params.limit ?? 200, 500));
  return rows.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
    routeKey: row.route_key,
    poolKind: row.pool_kind,
    evaluatedAt: row.evaluated_at,
    numbers: {
      pairRequestCostUsd: row.pair_request_cost_usd,
      leader:
        row.leader_model === null || row.leader_request_cost_usd === null
          ? null
          : {
              model: row.leader_model,
              variant: row.leader_variant,
              requestCostUsd: row.leader_request_cost_usd,
              value: row.leader_value,
              accuracy: row.leader_accuracy ?? 0,
            },
      budgetUsd: row.budget_usd,
      pairBestValue: row.pair_best_value,
    },
  }));
}
