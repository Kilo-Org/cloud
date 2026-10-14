import { describe, expect, it } from 'vitest';
import { mapConfigRows, toDeciderModelRows } from './config';

const configRow = {
  min_accuracy: 0.85,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  max_concurrency: 8,
  user_max_concurrency: 100,
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

const autoRows = [
  {
    model: 'auto/model',
    reasoning_effort: 'high',
    avg_attempt_cost_usd: 19.75,
    synced_at: configRow.updated_at,
  },
];

describe('platform model configuration', () => {
  it('defaults legacy rows to efficient with the configured ranking defaults', () => {
    const config = mapConfigRows(
      configRow,
      ['classifier'],
      [{ model: 'manual/model', variant: null, reasoning_effort: null }]
    );
    expect(config).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
      frontierMinAccuracyDelta: 0,
    });
  });

  it('preserves independent frontier ranking knobs and candidate selection', () => {
    const config = mapConfigRows(
      {
        ...configRow,
        router: 'frontier',
        accuracy_noise_band: 0.02,
        frontier_min_accuracy_delta: 0.1,
      },
      ['classifier'],
      [{ model: 'frontier/model', variant: null, reasoning_effort: null }]
    );
    expect(config).toMatchObject({
      router: 'frontier',
      accuracyNoiseBand: 0.02,
      frontierMinAccuracyDelta: 0.1,
      deciderModels: [{ id: 'frontier/model' }],
    });
  });

  it('preserves a configured confidence threshold and defaults old rows to disabled', () => {
    const models = [{ model: 'manual/model', variant: null, reasoning_effort: null }];
    expect(
      mapConfigRows(configRow, ['classifier/model'], models)?.lowConfidenceThreshold
    ).toBeNull();
    expect(
      mapConfigRows({ ...configRow, low_confidence_threshold: 0.8 }, ['classifier/model'], models)
        ?.lowConfidenceThreshold
    ).toBe(0.8);
  });

  it('discards stale saved variants and legacy selected efforts in every config list', () => {
    const result = mapConfigRows(
      configRow,
      ['classifier/model'],
      [{ model: 'manual/model', variant: 'retired', reasoning_effort: 'high' }],
      autoRows
    );
    expect(result?.manualDeciderModels).toEqual([{ id: 'manual/model' }]);
    expect(result?.autoDeciderModels).toEqual([{ id: 'auto/model', avgAttemptCostUsd: 19.75 }]);
    expect(result?.deciderModels).toEqual([{ id: 'manual/model' }, { id: 'auto/model' }]);
  });

  it('manual selections override auto exclusions and deduplicate the effective list', () => {
    const manual = [{ model: 'auto/model', variant: null, reasoning_effort: null }];
    expect(mapConfigRows(configRow, ['classifier/model'], manual, autoRows)?.deciderModels).toEqual(
      [{ id: 'auto/model' }]
    );
    expect(
      mapConfigRows(configRow, ['classifier/model'], manual, autoRows, ['auto/model'])
        ?.deciderModels
    ).toEqual([{ id: 'auto/model' }]);
  });

  it('clears legacy effort columns on save without dropping rolling-deploy storage', () => {
    expect(toDeciderModelRows([{ id: 'manual/model' }])).toEqual([
      { model: 'manual/model', variant: null, reasoning_effort: null },
    ]);
  });

  it('does not fabricate an unsaved or empty config', () => {
    const models = [{ model: 'manual/model', variant: null, reasoning_effort: null }];
    expect(mapConfigRows(null, ['classifier/model'], models)).toBeNull();
    expect(mapConfigRows(configRow, [], models)).toBeNull();
    expect(mapConfigRows(configRow, ['classifier/model'], [])).toBeNull();
  });
});
