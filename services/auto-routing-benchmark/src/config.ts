import { BenchmarkConfigSchema, type BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import { getConfigRow, saveConfigRow } from './db';

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  classifierModels: [
    'google/gemini-2.5-flash-lite',
    'google/gemini-2.5-flash',
    'openai/gpt-5-mini',
    'qwen/qwen3.7-plus',
  ],
  deciderModels: [
    { id: 'google/gemini-2.5-flash-lite', supportedApiKinds: ['chat_completions'] },
    { id: 'google/gemini-2.5-flash', supportedApiKinds: ['chat_completions'] },
    { id: 'qwen/qwen3.7-plus', supportedApiKinds: ['chat_completions'] },
    { id: 'openai/gpt-5.5', supportedApiKinds: ['chat_completions', 'responses'] },
    {
      id: 'anthropic/claude-sonnet-4.6',
      supportedApiKinds: ['chat_completions', 'messages', 'responses'],
    },
  ],
  minAccuracy: 0.7,
  maxConcurrency: 4,
  updatedAt: null,
  updatedBy: null,
};

// Pure so the fallback path is unit-testable without D1.
export function parseConfigJson(raw: string | null): BenchmarkConfig {
  if (raw === null) return DEFAULT_BENCHMARK_CONFIG;
  try {
    const parsed = BenchmarkConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_BENCHMARK_CONFIG;
  } catch {
    return DEFAULT_BENCHMARK_CONFIG;
  }
}

export async function getBenchmarkConfig(db: D1Database): Promise<BenchmarkConfig> {
  const row = await getConfigRow(db);
  return parseConfigJson(row?.config_json ?? null);
}

export async function saveBenchmarkConfig(
  db: D1Database,
  config: BenchmarkConfig,
  updatedBy: string | null
): Promise<BenchmarkConfig> {
  const updatedAt = new Date().toISOString();
  const stamped: BenchmarkConfig = { ...config, updatedAt, updatedBy };
  await saveConfigRow(db, JSON.stringify(stamped), updatedAt, updatedBy);
  return stamped;
}
