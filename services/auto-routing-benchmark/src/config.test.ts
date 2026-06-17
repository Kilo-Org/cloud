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
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: 'admin@example.com',
};

const deciderRows: ConfigDeciderModelRow[] = [
  {
    model: 'some/decider',
    reasoning_effort: 'high',
  },
];

describe('mapConfigRows', () => {
  it('returns null when config row is null', () => {
    expect(mapConfigRows(null, ['some/model'], deciderRows)).toBeNull();
  });

  it('returns null when classifierModels array is empty', () => {
    expect(mapConfigRows(configRow, [], deciderRows)).toBeNull();
  });

  it('returns null when deciderModels array is empty', () => {
    expect(mapConfigRows(configRow, ['some/model'], [])).toBeNull();
  });

  it('maps a full config row set to BenchmarkConfig', () => {
    const classifierModels = ['some/model-a', 'some/model-b'];

    const result = mapConfigRows(configRow, classifierModels, deciderRows);

    expect(result).not.toBeNull();
    expect(result?.minAccuracy).toBe(0.85);
    expect(result?.switchCostFactor).toBe(3);
    expect(result?.maxConcurrency).toBe(8);
    expect(result?.benchmarkUserId).toBe('user-123');
    expect(result?.benchmarkOrgId).toBe('org-123');
    expect(result?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(result?.updatedBy).toBe('admin@example.com');
    expect(result?.classifierModels).toEqual(classifierModels);
    expect(result?.deciderModels).toHaveLength(1);
    expect(result?.deciderModels[0].id).toBe('some/decider');
    expect(result?.deciderModels[0].reasoningEffort).toBe('high');
    expect(result?.classifierRepetitions).toBe(1);
    expect(result?.deciderRepetitions).toBe(1);
    expect(result?.classifierMaxP95LatencyMs).toBeNull();
  });
});
