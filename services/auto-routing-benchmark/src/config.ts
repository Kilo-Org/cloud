import type { BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import {
  getConfigRows,
  replaceConfig,
  type ConfigAutoDeciderModelRow,
  type ConfigDeciderModelRow,
} from './db';
import { parsePersistedReasoningEffort } from './reasoning-effort';

// Maps the three normalized config tables to the BenchmarkConfig contract.
// Null when no admin has saved a config yet — the worker never fabricates
// one, and runs cannot start until a config exists.
export function mapConfigRows(
  configRow: {
    min_accuracy: number;
    switch_cost_factor: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    auto_decider_min_cost_usd: number;
    auto_decider_max_cost_usd: number;
    updated_at: string;
    updated_by: string | null;
  } | null,
  classifierModels: string[],
  deciderModelRows: ConfigDeciderModelRow[],
  autoDeciderModelRows: ConfigAutoDeciderModelRow[] = [],
  excludedAutoDeciderModels: string[] = []
): BenchmarkConfig | null {
  const excludedAuto = new Set(excludedAutoDeciderModels);
  const manualDeciderModels = deciderModelRows.map(r => ({
    id: r.model,
    reasoningEffort: parsePersistedReasoningEffort(r.reasoning_effort),
  }));
  const manualIds = new Set(manualDeciderModels.map(model => model.id));
  const autoDeciderModels = autoDeciderModelRows.map(r => ({
    id: r.model,
    reasoningEffort: parsePersistedReasoningEffort(r.reasoning_effort),
    avgAttemptCostUsd: r.avg_attempt_cost_usd,
  }));
  const effectiveAutoDeciderModels = autoDeciderModels
    .filter(model => !excludedAuto.has(model.id))
    .filter(model => !manualIds.has(model.id))
    .map(model => ({ id: model.id, reasoningEffort: model.reasoningEffort }));
  const deciderModels = [...manualDeciderModels, ...effectiveAutoDeciderModels];

  if (configRow === null || classifierModels.length === 0 || deciderModels.length === 0) {
    return null;
  }

  return {
    classifierModels,
    deciderModels,
    manualDeciderModels,
    autoDeciderModels,
    excludedAutoDeciderModels,
    minAccuracy: configRow.min_accuracy,
    switchCostFactor: configRow.switch_cost_factor,
    maxConcurrency: configRow.max_concurrency,
    benchmarkUserId: configRow.benchmark_user_id,
    benchmarkOrgId: configRow.benchmark_org_id,
    classifierRepetitions: configRow.classifier_repetitions,
    deciderRepetitions: configRow.decider_repetitions,
    classifierMaxP95LatencyMs: configRow.classifier_max_p95_latency_ms,
    autoDeciderMinCostUsd: configRow.auto_decider_min_cost_usd,
    autoDeciderMaxCostUsd: configRow.auto_decider_max_cost_usd,
    updatedAt: configRow.updated_at,
    updatedBy: configRow.updated_by,
  };
}

export async function getBenchmarkConfig(db: D1Database): Promise<BenchmarkConfig | null> {
  const { config, classifierModels, deciderModels, autoDeciderModels, excludedAutoDeciderModels } =
    await getConfigRows(db);
  return mapConfigRows(
    config,
    classifierModels,
    deciderModels,
    autoDeciderModels,
    excludedAutoDeciderModels
  );
}

export async function saveBenchmarkConfig(
  db: D1Database,
  config: BenchmarkConfig,
  updatedBy: string | null
): Promise<BenchmarkConfig> {
  const updatedAt = new Date().toISOString();
  const stamped: BenchmarkConfig = { ...config, updatedAt, updatedBy };

  const manualDeciderModels = config.manualDeciderModels ?? config.deciderModels;
  const deciderModelRows: ConfigDeciderModelRow[] = manualDeciderModels.map(m => ({
    model: m.id,
    reasoning_effort: m.reasoningEffort ?? null,
  }));

  await replaceConfig(
    db,
    {
      min_accuracy: config.minAccuracy,
      switch_cost_factor: config.switchCostFactor,
      max_concurrency: config.maxConcurrency,
      benchmark_user_id: config.benchmarkUserId,
      benchmark_org_id: config.benchmarkOrgId,
      classifier_repetitions: config.classifierRepetitions,
      decider_repetitions: config.deciderRepetitions,
      classifier_max_p95_latency_ms: config.classifierMaxP95LatencyMs,
      auto_decider_min_cost_usd: config.autoDeciderMinCostUsd,
      auto_decider_max_cost_usd: config.autoDeciderMaxCostUsd,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    config.classifierModels,
    deciderModelRows,
    config.excludedAutoDeciderModels ?? []
  );

  return stamped;
}
