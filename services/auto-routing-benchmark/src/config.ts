import type { BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import { getConfigRows, replaceConfig, type ConfigDeciderModelRow } from './db';

// Maps the three normalized config tables to the BenchmarkConfig contract.
// Null when no admin has saved a config yet — the worker never fabricates
// one, and runs cannot start until a config exists.
export function mapConfigRows(
  configRow: {
    min_accuracy: number;
    switch_cost_factor: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    updated_at: string;
    updated_by: string | null;
  } | null,
  classifierModels: string[],
  deciderModelRows: ConfigDeciderModelRow[]
): BenchmarkConfig | null {
  if (configRow === null || classifierModels.length === 0 || deciderModelRows.length === 0) {
    return null;
  }

  return {
    classifierModels,
    deciderModels: deciderModelRows.map(r => ({
      id: r.model,
      reasoningEffort:
        r.reasoning_effort as BenchmarkConfig['deciderModels'][number]['reasoningEffort'],
    })),
    minAccuracy: configRow.min_accuracy,
    switchCostFactor: configRow.switch_cost_factor,
    maxConcurrency: configRow.max_concurrency,
    benchmarkUserId: configRow.benchmark_user_id,
    classifierRepetitions: configRow.classifier_repetitions,
    deciderRepetitions: configRow.decider_repetitions,
    classifierMaxP95LatencyMs: configRow.classifier_max_p95_latency_ms,
    updatedAt: configRow.updated_at,
    updatedBy: configRow.updated_by,
  };
}

export async function getBenchmarkConfig(db: D1Database): Promise<BenchmarkConfig | null> {
  const { config, classifierModels, deciderModels } = await getConfigRows(db);
  return mapConfigRows(config, classifierModels, deciderModels);
}

export async function saveBenchmarkConfig(
  db: D1Database,
  config: BenchmarkConfig,
  updatedBy: string | null
): Promise<BenchmarkConfig> {
  const updatedAt = new Date().toISOString();
  const stamped: BenchmarkConfig = { ...config, updatedAt, updatedBy };

  const deciderModelRows: ConfigDeciderModelRow[] = config.deciderModels.map(m => ({
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
      classifier_repetitions: config.classifierRepetitions,
      decider_repetitions: config.deciderRepetitions,
      classifier_max_p95_latency_ms: config.classifierMaxP95LatencyMs,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    config.classifierModels,
    deciderModelRows
  );

  return stamped;
}
