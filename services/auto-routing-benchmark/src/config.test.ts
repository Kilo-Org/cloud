import { describe, expect, it } from 'vitest';
import { mapConfigRows, toDeciderModelRows } from './config';
import type { ConfigDeciderModelRow } from './db';

const configRow = {
  id: 1 as const,
  min_accuracy: 0.85,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  max_concurrency: 8,
  benchmark_user_id: 'user-123',
  benchmark_org_id: 'org-123',
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: null,
  auto_decider_min_cost_usd: 12,
  auto_decider_max_cost_usd: 24,
  user_max_concurrency: 100,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: 'admin@example.com',
};

const deciderRows: ConfigDeciderModelRow[] = [
  {
    model: 'some/decider',
    variant: null,
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
    expect(result?.bestAccuracySwitchThreshold).toBe(0.05);
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
      [{ model: 'auto/model', variant: null, reasoning_effort: 'medium' }],
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
      [{ model: 'manual/thinking', variant: null, reasoning_effort: 'thinking' }],
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

  it('maps a canonical variant row to variant with reasoningEffort null (never through the effort parser)', () => {
    const result = mapConfigRows(
      configRow,
      ['some/model'],
      [{ model: 'manual/max', variant: 'max', reasoning_effort: null }],
      [],
      []
    );

    expect(result?.manualDeciderModels).toEqual([
      { id: 'manual/max', variant: 'max', reasoningEffort: null },
    ]);
    expect(result?.deciderModels[0].variant).toBe('max');
    expect(result?.deciderModels[0].reasoningEffort).toBeNull();
  });

  it('maps a legacy effort row to reasoningEffort with no variant key', () => {
    const result = mapConfigRows(
      configRow,
      ['some/model'],
      [{ model: 'manual/high', variant: null, reasoning_effort: 'high' }],
      [],
      []
    );

    const manual = result?.manualDeciderModels?.[0];
    expect(manual).toEqual({ id: 'manual/high', reasoningEffort: 'high' });
    // Regression guard for run.ts: a legacy row must not carry `variant` at all;
    // a present `variant: null` would be read as "no variant" and drop the effort.
    expect('variant' in (manual ?? {})).toBe(false);
  });
});

describe('toDeciderModelRows', () => {
  it('writes variant for a canonical model and reasoning_effort for a legacy model, never both', () => {
    const rows = toDeciderModelRows([
      { id: 'canonical/max', variant: 'max', reasoningEffort: null },
      { id: 'legacy/high', reasoningEffort: 'high' },
      { id: 'plain/model', reasoningEffort: null },
    ]);

    expect(rows).toEqual([
      { model: 'canonical/max', variant: 'max', reasoning_effort: null },
      { model: 'legacy/high', variant: null, reasoning_effort: 'high' },
      { model: 'plain/model', variant: null, reasoning_effort: null },
    ]);
    for (const row of rows) {
      expect(row.variant === null || row.reasoning_effort === null).toBe(true);
    }
  });
});
