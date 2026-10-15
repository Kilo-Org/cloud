import type {
  AutoRouter,
  BenchmarkConfig,
  BenchmarkPlatformModel,
  ProductionTokenProfile,
} from '@kilocode/auto-routing-contracts';
import {
  parseStoredPolicyComputed,
  parseStoredPolicyOverrides,
} from '@kilocode/auto-routing-contracts';
import { getConfigRows, replaceConfig, type ConfigDeciderModelRow } from './db';

// Retain nullable legacy columns for rolling deploys, but never read saved efforts.
export function toDeciderModelRows(models: BenchmarkPlatformModel[]): ConfigDeciderModelRow[] {
  return models.map(m => ({
    model: m.id,
    variant: null,
    reasoning_effort: null,
  }));
}

// Maps the three normalized config tables to the BenchmarkConfig contract.
// Null when no admin has saved a config yet — the worker never fabricates
// one, and runs cannot start until a config exists.
export function mapConfigRows(
  configRow: {
    router?: AutoRouter;
    accuracy_noise_band?: number;
    frontier_min_accuracy_delta?: number;
    min_accuracy: number;
    switch_cost_factor: number;
    best_accuracy_switch_threshold: number;
    production_token_profile?: ProductionTokenProfile | null;
    switch_horizon_turns?: number | null;
    low_confidence_threshold?: number | null;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    // Stored JSON; entries that fail their key's schema are ignored on read.
    policy_overrides?: unknown;
    policy_computed?: unknown;
    updated_at: string;
    updated_by: string | null;
  } | null,
  classifierModels: string[],
  deciderModelRows: ConfigDeciderModelRow[]
): BenchmarkConfig | null {
  const deciderModels = deciderModelRows.map(r => ({ id: r.model }));

  if (configRow === null || classifierModels.length === 0 || deciderModels.length === 0) {
    return null;
  }

  return {
    router: configRow.router ?? 'efficient',
    accuracyNoiseBand: configRow.accuracy_noise_band ?? 0.05,
    frontierMinAccuracyDelta: configRow.frontier_min_accuracy_delta ?? 0,
    classifierModels,
    deciderModels,
    minAccuracy: configRow.min_accuracy,
    switchCostFactor: configRow.switch_cost_factor,
    bestAccuracySwitchThreshold: configRow.best_accuracy_switch_threshold,
    productionTokenProfile: configRow.production_token_profile ?? null,
    switchHorizonTurns: configRow.switch_horizon_turns ?? null,
    lowConfidenceThreshold: configRow.low_confidence_threshold ?? null,
    benchmarkUserId: configRow.benchmark_user_id,
    benchmarkOrgId: configRow.benchmark_org_id,
    classifierRepetitions: configRow.classifier_repetitions,
    deciderRepetitions: configRow.decider_repetitions,
    classifierMaxP95LatencyMs: configRow.classifier_max_p95_latency_ms,
    policyOverrides: parseStoredPolicyOverrides(configRow.policy_overrides),
    policyComputed: parseStoredPolicyComputed(configRow.policy_computed),
    updatedAt: configRow.updated_at,
    updatedBy: configRow.updated_by,
  };
}

export async function getBenchmarkConfig(
  db: D1Database,
  router: AutoRouter = 'efficient'
): Promise<BenchmarkConfig | null> {
  const { config, classifierModels, deciderModels } = await getConfigRows(db, router);
  return mapConfigRows(config, classifierModels, deciderModels);
}

export async function saveBenchmarkConfig(
  db: D1Database,
  config: BenchmarkConfig,
  updatedBy: string | null
): Promise<BenchmarkConfig> {
  const updatedAt = new Date().toISOString();
  const stamped: BenchmarkConfig = { ...config, updatedAt, updatedBy };
  const existing = await getBenchmarkConfig(db, config.router);

  const deciderModelRows = toDeciderModelRows(config.deciderModels);

  await replaceConfig(
    db,
    {
      min_accuracy: config.minAccuracy,
      accuracy_noise_band: config.accuracyNoiseBand,
      frontier_min_accuracy_delta: config.frontierMinAccuracyDelta,
      switch_cost_factor: config.switchCostFactor,
      best_accuracy_switch_threshold: config.bestAccuracySwitchThreshold,
      production_token_profile: config.productionTokenProfile,
      switch_horizon_turns: config.switchHorizonTurns,
      low_confidence_threshold: config.lowConfidenceThreshold,
      benchmark_user_id: config.benchmarkUserId,
      benchmark_org_id: config.benchmarkOrgId,
      classifier_repetitions: config.classifierRepetitions,
      decider_repetitions: config.deciderRepetitions,
      classifier_max_p95_latency_ms: config.classifierMaxP95LatencyMs,
      policy_overrides: config.policyOverrides ?? null,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    config.classifierModels,
    deciderModelRows,
    config.router
  );

  // The computed map is server-owned: an admin save must not clear it.
  return { ...stamped, policyComputed: existing?.policyComputed ?? null };
}
