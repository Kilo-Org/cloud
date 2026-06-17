import { describe, expect, it } from 'vitest';
import { mapConfigRows } from './config';
import type { ConfigDeciderModelRow } from './db';

const configRow = {
  id: 1 as const,
  min_accuracy: 0.85,
  switch_cost_factor: 3,
  max_concurrency: 8,
  benchmark_user_id: 'user-123',
  benchmark_org_id: 'org-123',
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: null,
  auto_decider_min_cost_usd: 12,
  auto_decider_max_cost_usd: 24,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: 'admin@example.com',
};

const deciderRows: ConfigDeciderModelRow[] = [
  {
    model: 'some/decider',
    reasoning_effort: 'high',
  },
];

const autoRows = [
  {
    model: 'auto/model',
    reasoning_effort: null,
    avg_attempt_cost_usd: 19.75,
    synced_at: '2026-06-01T01:00:00.000Z',
  },
];

describe('mapConfigRows', () => {
  it('returns null when config row is null', () => {
    expect(mapConfigRows(null, ['some/model'], deciderRows, autoRows, [])).toBeNull();
  });

  it('returns null when classifierModels array is empty', () => {
    expect(mapConfigRows(configRow, [], deciderRows, autoRows, [])).toBeNull();
  });

  it('returns null when deciderModels array is empty', () => {
    expect(mapConfigRows(configRow, ['some/model'], [], [], [])).toBeNull();
  });

  it('maps a full config row set to BenchmarkConfig', () => {
    const classifierModels = ['some/model-a', 'some/model-b'];

    const result = mapConfigRows(configRow, classifierModels, deciderRows, autoRows, []);

    expect(result).not.toBeNull();
    expect(result?.minAccuracy).toBe(0.85);
    expect(result?.switchCostFactor).toBe(3);
    expect(result?.maxConcurrency).toBe(8);
    expect(result?.benchmarkUserId).toBe('user-123');
    expect(result?.benchmarkOrgId).toBe('org-123');
    expect(result?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(result?.updatedBy).toBe('admin@example.com');
    expect(result?.classifierModels).toEqual(classifierModels);
    expect(result?.deciderModels).toHaveLength(2);
    expect(result?.deciderModels[0].id).toBe('some/decider');
    expect(result?.deciderModels[0].reasoningEffort).toBe('high');
    expect(result?.manualDeciderModels).toEqual([{ id: 'some/decider', reasoningEffort: 'high' }]);
    expect(result?.autoDeciderModels).toEqual([
      { id: 'auto/model', reasoningEffort: null, avgAttemptCostUsd: 19.75 },
    ]);
    expect(result?.classifierRepetitions).toBe(1);
    expect(result?.deciderRepetitions).toBe(1);
    expect(result?.classifierMaxP95LatencyMs).toBeNull();
    expect(result?.autoDeciderMinCostUsd).toBe(12);
    expect(result?.autoDeciderMaxCostUsd).toBe(24);
  });

  it('excludes only auto decider models, leaving a manual model with the same id included', () => {
    const result = mapConfigRows(
      configRow,
      ['some/model'],
      [{ model: 'auto/model', reasoning_effort: 'medium' }],
      autoRows,
      ['auto/model']
    );

    expect(result?.deciderModels).toEqual([{ id: 'auto/model', reasoningEffort: 'medium' }]);
    expect(result?.excludedAutoDeciderModels).toEqual(['auto/model']);
  });

  it('normalizes unsupported persisted reasoning effort values to null', () => {
    const result = mapConfigRows(
      configRow,
      ['some/model'],
      [{ model: 'manual/thinking', reasoning_effort: 'thinking' }],
      [
        {
          model: 'auto/none',
          reasoning_effort: 'none',
          avg_attempt_cost_usd: 20,
          synced_at: '2026-06-01T01:00:00.000Z',
        },
      ],
      []
    );

    expect(result?.manualDeciderModels).toEqual([{ id: 'manual/thinking', reasoningEffort: null }]);
    expect(result?.autoDeciderModels).toEqual([
      { id: 'auto/none', reasoningEffort: null, avgAttemptCostUsd: 20 },
    ]);
    expect(result?.deciderModels).toEqual([
      { id: 'manual/thinking', reasoningEffort: null },
      { id: 'auto/none', reasoningEffort: null },
    ]);
  });
});
