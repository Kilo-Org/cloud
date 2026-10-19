import { createHash } from 'node:crypto';
import {
  estimateRequestCostUsd,
  benchmarkPairKey,
  ProductionAutoMetricsResponseSchema,
  rankCandidates,
  resolveEffectivePolicy,
  type AutoRouter,
  type BenchmarkConfig,
  type CandidatePricing,
  type PolicySettingComputedMap,
  type ProductionAutoMetrics,
  type ProductionTokenProfile,
} from '@kilocode/auto-routing-contracts';
import { getBenchmarkConfig } from './config';
import {
  getRoutingCaseResultsForEntries,
  listReadyCurrentProfilesForEntries,
  savePolicyComputed,
} from './db';
import {
  catalogCandidatePrices,
  fetchBenchmarkModelCatalog,
  platformRegistryEntries,
} from './platform-models';
import { variantFromStorage } from './reasoning-effort';
import { computeEngineIdentity } from './run';
import { isGradedSweepResult, summarizeSweep } from './scoreboard/sweep';
import type { OfflineSweep, OfflineSweepSummary } from './scoreboard/schema';

export const MIN_ACCURACY_GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9] as const;
export const ACCURACY_NOISE_BAND_GRID = [0, 0.02, 0.05, 0.08, 0.1] as const;

// Below this the held-out sample cannot separate two thresholds, so the
// optimizer declines to change anything and the current value stands.
const MIN_HELDOUT_GRADED_CASES = 20;
const MIN_EVALUATED_ROUTES = 2;
// Quality may fall at most this far below the best grid point.
const ACCURACY_FLOOR_MARGIN = 0.05;
// Objective values within this share of the best count as the same plateau.
const PLATEAU_TOLERANCE = 0.02;
const MIN_REQUEST_COST_USD = 1e-9;

export type ThresholdOptimization = {
  minAccuracy: number;
  accuracyNoiseBand: number;
  heldOutAccuracy: number;
  estimatedRequestCostUsd: number;
  heldOutCases: number;
  routes: number;
  evidence: string;
};

/** Same deterministic train/held-out split the offline sweep uses. */
export function caseSplitForId(caseId: string): 'train' | 'heldOut' {
  return createHash('sha256').update(caseId).digest().readUInt8(0) % 2 === 0 ? 'train' : 'heldOut';
}

type GridPoint = {
  minAccuracy: number;
  accuracyNoiseBand: number;
  accuracy: number;
  costUsd: number;
  objective: number;
  cases: number;
  routes: number;
};

function closestTo(values: readonly number[], target: number): number | undefined {
  return values.reduce<number | undefined>(
    (best, value) =>
      best === undefined || Math.abs(value - target) < Math.abs(best - target) ? value : best,
    undefined
  );
}

/**
 * Grid the min-accuracy threshold and noise band over measured candidates,
 * scoring each candidate table on held-out cases: mean estimated request cost
 * per held-out case against the accuracy that table actually achieves. The
 * chosen point is the middle of the stable plateau, not its edge.
 *
 * Returns null when the stored case results cannot support a decision.
 */
export function optimizeThresholdPolicy(params: {
  pairs: OfflineSweep['pairs'];
  profile: ProductionTokenProfile | null;
  pricing: ReadonlyMap<string, CandidatePricing | null>;
}): ThresholdOptimization | null {
  const splitPairs = params.pairs.map(pair => ({
    ...pair,
    results: pair.results.map(result => ({ ...result, split: caseSplitForId(result.caseId) })),
  }));
  const summaries = summarizeSweep(splitPairs);

  // Every model on a route is graded on the same held-out cases, so the sample
  // size is the distinct case ids per route, not the sum over models.
  const heldOutCaseIdsByRoute = new Map<string, Set<string>>();
  for (const pair of splitPairs) {
    for (const result of pair.results) {
      if (result.split !== 'heldOut' || !isGradedSweepResult(result)) continue;
      let caseIds = heldOutCaseIdsByRoute.get(result.routeKey);
      if (!caseIds) {
        caseIds = new Set();
        heldOutCaseIdsByRoute.set(result.routeKey, caseIds);
      }
      caseIds.add(result.caseId);
    }
  }
  let heldOutCases = 0;
  for (const caseIds of heldOutCaseIdsByRoute.values()) heldOutCases += caseIds.size;

  const byRoute = new Map<
    string,
    Map<string, { train?: OfflineSweepSummary; heldOut?: OfflineSweepSummary }>
  >();
  let evaluableRoutes = 0;
  for (const summary of summaries) {
    const key = benchmarkPairKey({ model: summary.model, variant: summary.variant });
    let candidates = byRoute.get(summary.routeKey);
    if (!candidates) {
      candidates = new Map();
      byRoute.set(summary.routeKey, candidates);
    }
    const entry: { train?: OfflineSweepSummary; heldOut?: OfflineSweepSummary } =
      candidates.get(key) ?? {};
    if (summary.split === 'train') entry.train = summary;
    else entry.heldOut = summary;
    candidates.set(key, entry);
  }
  for (const candidates of byRoute.values()) {
    if (
      [...candidates.values()].some(
        entry => (entry.train?.cases ?? 0) > 0 && (entry.heldOut?.cases ?? 0) > 0
      )
    ) {
      evaluableRoutes += 1;
    }
  }
  if (heldOutCases < MIN_HELDOUT_GRADED_CASES || evaluableRoutes < MIN_EVALUATED_ROUTES) {
    return null;
  }

  const points: GridPoint[] = [];
  for (const minAccuracy of MIN_ACCURACY_GRID) {
    for (const accuracyNoiseBand of ACCURACY_NOISE_BAND_GRID) {
      let scoreSum = 0;
      let costSum = 0;
      let cases = 0;
      let routes = 0;
      for (const candidates of byRoute.values()) {
        const trainCandidates = [...candidates.values()].flatMap(entry =>
          entry.train && entry.train.cases > 0 && entry.train.accuracy !== null
            ? [
                {
                  model: entry.train.model,
                  variant: entry.train.variant,
                  accuracy: entry.train.accuracy,
                  cases: entry.train.cases,
                  avgCostUsd: entry.train.avgCostUsd ?? 0,
                  p50LatencyMs: entry.train.p50LatencyMs,
                  pricing: params.pricing.get(entry.train.model) ?? null,
                },
              ]
            : []
        );
        if (trainCandidates.length === 0) continue;
        const pick = rankCandidates(trainCandidates, minAccuracy, {
          profile: params.profile,
          accuracyNoiseBand,
        })[0];
        if (!pick) continue;
        const heldOut = candidates.get(
          benchmarkPairKey({ model: pick.model, variant: pick.variant ?? null })
        )?.heldOut;
        if (!heldOut || heldOut.cases === 0 || heldOut.accuracy === null) continue;
        scoreSum += heldOut.accuracy * heldOut.cases;
        costSum +=
          estimateRequestCostUsd(
            { avgCostUsd: pick.avgCostUsd, pricing: pick.pricing ?? null },
            params.profile
          ) * heldOut.cases;
        cases += heldOut.cases;
        routes += 1;
      }
      if (cases === 0) continue;
      const accuracy = scoreSum / cases;
      const costUsd = costSum / cases;
      points.push({
        minAccuracy,
        accuracyNoiseBand,
        accuracy,
        costUsd,
        objective: accuracy / Math.max(costUsd, MIN_REQUEST_COST_USD),
        cases,
        routes,
      });
    }
  }
  if (points.length === 0) return null;

  const maxAccuracy = Math.max(...points.map(point => point.accuracy));
  const floor = maxAccuracy - ACCURACY_FLOOR_MARGIN;
  const eligible = points.filter(point => point.accuracy >= floor);
  const bestObjective = Math.max(...eligible.map(point => point.objective));
  const plateau = eligible.filter(
    point => point.objective >= bestObjective * (1 - PLATEAU_TOLERANCE)
  );

  const accuracyValues = [...new Set(plateau.map(point => point.minAccuracy))].sort(
    (a, b) => a - b
  );
  const chosenMinAccuracy = closestTo(
    accuracyValues,
    (accuracyValues[0] + accuracyValues[accuracyValues.length - 1]) / 2
  );
  const bandPoints = plateau.filter(point => point.minAccuracy === chosenMinAccuracy);
  const bandValues = [...new Set(bandPoints.map(point => point.accuracyNoiseBand))].sort(
    (a, b) => a - b
  );
  const chosenBand = closestTo(bandValues, (bandValues[0] + bandValues[bandValues.length - 1]) / 2);
  const chosen = bandPoints.find(point => point.accuracyNoiseBand === chosenBand) ?? bandPoints[0];
  if (!chosen) return null;

  return {
    minAccuracy: chosen.minAccuracy,
    accuracyNoiseBand: chosen.accuracyNoiseBand,
    heldOutAccuracy: chosen.accuracy,
    estimatedRequestCostUsd: chosen.costUsd,
    heldOutCases: chosen.cases,
    routes: chosen.routes,
    evidence: `held-out grid minAccuracy ${chosen.minAccuracy.toFixed(2)}, noise band ${chosen.accuracyNoiseBand.toFixed(2)}: accuracy ${(chosen.accuracy * 100).toFixed(1)}% at $${chosen.costUsd.toFixed(5)}/request over ${chosen.cases} cases on ${chosen.routes} routes`,
  };
}

/**
 * Read production auto-request usage from the web app. Returns null when the
 * endpoint is unavailable, slow, or has no data, so the daily run keeps the
 * last computed values instead of inventing numbers or stalling the tick.
 */
export async function fetchProductionAutoMetrics(env: Env): Promise<ProductionAutoMetrics | null> {
  try {
    const secret = await env.INTERNAL_API_SECRET_PROD.get();
    const response = await fetch(
      `${env.KILO_WEB_API_BASE_URL}/api/internal/auto-routing-benchmark/production-profile`,
      {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: 'production_auto_metrics_unavailable',
          status: response.status,
        })
      );
      return null;
    }
    const parsed = ProductionAutoMetricsResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.metrics : null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'production_auto_metrics_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
}

/**
 * Recompute every auto policy setting for one router and store the result.
 * Idempotent: rerunning on unchanged data writes the same values. Settings the
 * run cannot compute keep their previous record.
 */
export async function reevaluateSystemOptimalSettings(
  env: Env,
  router: AutoRouter,
  production: ProductionAutoMetrics | null
): Promise<PolicySettingComputedMap | null> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return null;

  const computedAt = new Date().toISOString();
  const fresh: PolicySettingComputedMap = {};
  if (production && production.sampleRequests > 0) {
    fresh.productionTokenProfile = {
      value: {
        uncachedInputTokens: production.uncachedInputTokens,
        cachedInputTokens: production.cachedInputTokens,
      },
      computedAt,
      source: 'production-usage',
      evidence: `mean input tokens over ${production.sampleRequests} auto requests in the last ${production.windowHours}h`,
    };
    if (production.medianTurnsPerSession !== null) {
      const turns = Math.max(1, Math.round(production.medianTurnsPerSession));
      fresh.switchHorizonTurns = {
        value: turns,
        computedAt,
        source: 'production-usage',
        evidence: `median ${production.medianTurnsPerSession.toFixed(1)} auto requests per session in the last ${production.windowHours}h`,
      };
    }
  }

  const profile = resolveEffectivePolicy({
    ...config,
    policyComputed: { ...(config.policyComputed ?? {}), ...fresh },
  }).productionTokenProfile;
  // The thresholds need the catalog and registry; the production records above
  // do not, so a catalog or D1 failure here must not discard them.
  const optimization = await optimizeRegistryThresholds(env, config, router, profile).catch(
    error => {
      console.warn(
        JSON.stringify({
          event: 'system_optimal_thresholds_skipped',
          router,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return null;
    }
  );
  if (optimization) {
    fresh.minAccuracy = {
      value: optimization.minAccuracy,
      computedAt,
      source: 'held-out-grid',
      evidence: optimization.evidence,
    };
    fresh.accuracyNoiseBand = {
      value: optimization.accuracyNoiseBand,
      computedAt,
      source: 'held-out-grid',
      evidence: optimization.evidence,
    };
  }

  if (Object.keys(fresh).length === 0) return null;
  const saved = { ...(config.policyComputed ?? {}), ...fresh };
  await savePolicyComputed(env.BENCH_DB, router, saved);
  return saved;
}

async function optimizeRegistryThresholds(
  env: Env,
  config: BenchmarkConfig,
  router: AutoRouter,
  profile: ProductionTokenProfile | null
): Promise<ThresholdOptimization | null> {
  const current = {
    router,
    engineIdentity: computeEngineIdentity('decider', router),
    repetitions: config.deciderRepetitions,
  };
  const catalog = await fetchBenchmarkModelCatalog(env);
  const desired = platformRegistryEntries(config, catalog);
  const readyRows = await listReadyCurrentProfilesForEntries(env.BENCH_DB, current, desired);
  const readyEntries = readyRows
    .filter((row): row is typeof row & { run_id: string } => Boolean(row.run_id))
    .map(row => ({
      entry: { model: row.model, variant: variantFromStorage(row.variant) },
      runId: row.run_id,
    }));
  if (readyEntries.length === 0) return null;
  return optimizeThresholdPolicy({
    pairs: await getRoutingCaseResultsForEntries(env.BENCH_DB, readyEntries),
    profile,
    pricing: catalogCandidatePrices(catalog),
  });
}
