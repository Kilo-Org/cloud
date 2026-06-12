import type { BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import { apiKindsToFlags, getConfigRows, replaceConfig, type ConfigDeciderModelRow } from './db';

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  classifierModels: [
    'google/gemini-2.5-flash-lite',
    'google/gemini-2.5-flash',
    'openai/gpt-5-mini',
    'qwen/qwen3.7-plus',
  ],
  deciderModels: [
    {
      id: 'google/gemini-2.5-flash-lite',
      supportedApiKinds: ['chat_completions'],
      reasoningEffort: null,
    },
    {
      id: 'google/gemini-2.5-flash',
      supportedApiKinds: ['chat_completions'],
      reasoningEffort: null,
    },
    { id: 'qwen/qwen3.7-plus', supportedApiKinds: ['chat_completions'], reasoningEffort: null },
    {
      id: 'openai/gpt-5.5',
      supportedApiKinds: ['chat_completions', 'responses'],
      reasoningEffort: null,
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      supportedApiKinds: ['chat_completions', 'messages', 'responses'],
      reasoningEffort: null,
    },
  ],
  minAccuracy: 0.7,
  maxConcurrency: 4,
  benchmarkUserId: null,
  updatedAt: null,
  updatedBy: null,
};

// Maps the three normalized config tables to the BenchmarkConfig contract.
// Falls back to DEFAULT_BENCHMARK_CONFIG fields when no config row exists.
export function mapConfigRows(
  configRow: {
    min_accuracy: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    updated_at: string;
    updated_by: string | null;
  } | null,
  classifierModels: string[],
  deciderModelRows: ConfigDeciderModelRow[]
): BenchmarkConfig {
  if (configRow === null || classifierModels.length === 0 || deciderModelRows.length === 0) {
    return DEFAULT_BENCHMARK_CONFIG;
  }

  return {
    classifierModels,
    deciderModels: deciderModelRows.map(r => ({
      id: r.model,
      supportedApiKinds: [
        ...(r.supports_chat_completions ? (['chat_completions'] as const) : []),
        ...(r.supports_messages ? (['messages'] as const) : []),
        ...(r.supports_responses ? (['responses'] as const) : []),
      ],
      reasoningEffort:
        r.reasoning_effort as BenchmarkConfig['deciderModels'][number]['reasoningEffort'],
    })),
    minAccuracy: configRow.min_accuracy,
    maxConcurrency: configRow.max_concurrency,
    benchmarkUserId: configRow.benchmark_user_id,
    updatedAt: configRow.updated_at,
    updatedBy: configRow.updated_by,
  };
}

export async function getBenchmarkConfig(db: D1Database): Promise<BenchmarkConfig> {
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
    ...apiKindsToFlags(m.supportedApiKinds),
  }));

  await replaceConfig(
    db,
    {
      min_accuracy: config.minAccuracy,
      max_concurrency: config.maxConcurrency,
      benchmark_user_id: config.benchmarkUserId,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    config.classifierModels,
    deciderModelRows
  );

  return stamped;
}
