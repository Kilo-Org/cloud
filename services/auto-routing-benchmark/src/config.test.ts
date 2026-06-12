import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_CONFIG, mapConfigRows } from './config';
import type { ConfigDeciderModelRow } from './db';

const defaultDeciderRows: ConfigDeciderModelRow[] = DEFAULT_BENCHMARK_CONFIG.deciderModels.map(
  m => ({
    model: m.id,
    reasoning_effort: m.reasoningEffort ?? null,
    supports_chat_completions: m.supportedApiKinds.includes('chat_completions'),
    supports_messages: m.supportedApiKinds.includes('messages'),
    supports_responses: m.supportedApiKinds.includes('responses'),
  })
);

const defaultConfigRow = {
  id: 1 as const,
  min_accuracy: DEFAULT_BENCHMARK_CONFIG.minAccuracy,
  max_concurrency: DEFAULT_BENCHMARK_CONFIG.maxConcurrency,
  benchmark_user_id: DEFAULT_BENCHMARK_CONFIG.benchmarkUserId,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: null,
};

describe('mapConfigRows', () => {
  it('returns defaults when config row is null', () => {
    expect(mapConfigRows(null, [], [])).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it('returns defaults when classifierModels array is empty', () => {
    expect(mapConfigRows(defaultConfigRow, [], defaultDeciderRows)).toEqual(
      DEFAULT_BENCHMARK_CONFIG
    );
  });

  it('returns defaults when deciderModels array is empty', () => {
    expect(mapConfigRows(defaultConfigRow, DEFAULT_BENCHMARK_CONFIG.classifierModels, [])).toEqual(
      DEFAULT_BENCHMARK_CONFIG
    );
  });

  it('maps a full config row set to BenchmarkConfig', () => {
    const configRow = {
      id: 1 as const,
      min_accuracy: 0.85,
      max_concurrency: 8,
      benchmark_user_id: 'user-123',
      updated_at: '2026-06-01T00:00:00.000Z',
      updated_by: 'admin@example.com',
    };
    const classifierModels = ['some/model-a', 'some/model-b'];
    const deciderRows: ConfigDeciderModelRow[] = [
      {
        model: 'some/decider',
        reasoning_effort: 'high',
        supports_chat_completions: true,
        supports_messages: true,
        supports_responses: false,
      },
    ];

    const result = mapConfigRows(configRow, classifierModels, deciderRows);

    expect(result.minAccuracy).toBe(0.85);
    expect(result.maxConcurrency).toBe(8);
    expect(result.benchmarkUserId).toBe('user-123');
    expect(result.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(result.updatedBy).toBe('admin@example.com');
    expect(result.classifierModels).toEqual(classifierModels);
    expect(result.deciderModels).toHaveLength(1);
    expect(result.deciderModels[0].id).toBe('some/decider');
    expect(result.deciderModels[0].reasoningEffort).toBe('high');
    expect(result.deciderModels[0].supportedApiKinds).toEqual(['chat_completions', 'messages']);
  });

  it('round-trips the default config through rows', () => {
    const result = mapConfigRows(
      defaultConfigRow,
      DEFAULT_BENCHMARK_CONFIG.classifierModels,
      defaultDeciderRows
    );
    // updatedAt/updatedBy come from the row, not DEFAULT_BENCHMARK_CONFIG (which has null)
    expect(result.minAccuracy).toBe(DEFAULT_BENCHMARK_CONFIG.minAccuracy);
    expect(result.maxConcurrency).toBe(DEFAULT_BENCHMARK_CONFIG.maxConcurrency);
    expect(result.classifierModels).toEqual(DEFAULT_BENCHMARK_CONFIG.classifierModels);
    expect(result.deciderModels.map(m => m.id)).toEqual(
      DEFAULT_BENCHMARK_CONFIG.deciderModels.map(m => m.id)
    );
  });
});
