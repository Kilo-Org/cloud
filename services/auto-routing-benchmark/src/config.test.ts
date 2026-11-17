import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '@kilocode/auto-routing-contracts';
import { mapConfigRows, toDeciderModelRows } from './config';

const configRow = {
  min_accuracy: 0.85,
  switch_cost_factor: 3,
  best_accuracy_switch_threshold: 0.05,
  benchmark_user_id: 'user-123',
  benchmark_org_id: 'org-123',
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: null,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: 'admin@example.com',
};

const models = [{ model: 'manual/model', variant: null, reasoning_effort: null }];

describe('platform model configuration', () => {
  it('defaults legacy rows to efficient with the configured ranking defaults', () => {
    const config = mapConfigRows(configRow, ['classifier'], models);
    expect(config).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
    });
  });

  it('preserves the stored accuracy noise band and candidate selection for frontier', () => {
    const frontierRow = {
      ...configRow,
      router: 'frontier' as const,
      accuracy_noise_band: 0.02,
      frontier_min_accuracy_delta: 0.1,
    };
    const config = mapConfigRows(
      frontierRow,
      ['classifier'],
      [{ model: 'frontier/model', variant: null, reasoning_effort: null }]
    );
    expect(config).toMatchObject({
      router: 'frontier',
      accuracyNoiseBand: 0.02,
      deciderModels: [{ id: 'frontier/model' }],
    });
    expect(config).not.toHaveProperty('frontierMinAccuracyDelta');
  });

  it('ignores the seven legacy fixed policy columns in a stored row', () => {
    const legacyRow = {
      ...configRow,
      switch_cost_factor: 50,
      low_confidence_threshold: 0.8,
      classifier_repetitions: 3,
      decider_repetitions: 2,
      classifier_max_p95_latency_ms: 1000,
    };
    const config = mapConfigRows(legacyRow, ['classifier/model'], models);
    if (config === null) throw new Error('expected a mapped config');
    for (const key of [
      'frontierMinAccuracyDelta',
      'switchCostFactor',
      'bestAccuracySwitchThreshold',
      'lowConfidenceThreshold',
      'classifierRepetitions',
      'deciderRepetitions',
      'classifierMaxP95LatencyMs',
    ]) {
      expect(config).not.toHaveProperty(key);
    }
    const policy = resolveEffectivePolicy(config);
    expect(policy.switchCostFactor).toBe(3);
    expect(policy.lowConfidenceThreshold).toBeNull();
    expect(policy.classifierRepetitions).toBe(1);
    expect(policy.deciderRepetitions).toBe(1);
    expect(policy.classifierMaxP95LatencyMs).toBeNull();
  });

  it.each(['efficient', 'frontier'] as const)(
    'uses only configured models and discards legacy efforts for %s',
    router => {
      const result = mapConfigRows(
        { ...configRow, router },
        ['classifier/model'],
        [{ model: 'configured/model', variant: 'retired', reasoning_effort: 'high' }]
      );
      expect(result?.deciderModels).toEqual([{ id: 'configured/model' }]);
    }
  );

  it('clears legacy effort columns on save without dropping rolling-deploy storage', () => {
    expect(toDeciderModelRows([{ id: 'manual/model' }])).toEqual([
      { model: 'manual/model', variant: null, reasoning_effort: null },
    ]);
  });

  it('does not fabricate an unsaved or empty config', () => {
    expect(mapConfigRows(null, ['classifier/model'], models)).toBeNull();
    expect(mapConfigRows(configRow, [], models)).toBeNull();
    expect(mapConfigRows(configRow, ['classifier/model'], [])).toBeNull();
  });

  it('maps policy override and computed columns, defaulting absent ones to null', () => {
    expect(mapConfigRows(configRow, ['classifier/model'], models)).toMatchObject({
      policyOverrides: null,
      policyComputed: null,
    });
    expect(
      mapConfigRows(
        {
          ...configRow,
          policy_overrides: { minAccuracy: 0.9 },
          policy_computed: {
            accuracyNoiseBand: {
              value: 0.08,
              computedAt: '2026-06-01T00:00:00.000Z',
              source: 'held-out-grid',
              evidence: 'fixture',
            },
          },
        },
        ['classifier/model'],
        models
      )
    ).toMatchObject({
      policyOverrides: { minAccuracy: 0.9 },
      policyComputed: {
        accuracyNoiseBand: { value: 0.08, source: 'held-out-grid' },
      },
    });
  });

  it('drops stored policy entries that do not fit their setting', () => {
    const config = mapConfigRows(
      {
        ...configRow,
        policy_overrides: {
          minAccuracy: { uncachedInputTokens: 1000, cachedInputTokens: 200 },
          accuracyNoiseBand: 0.03,
        },
        policy_computed: {
          minAccuracy: {
            value: { uncachedInputTokens: 1000, cachedInputTokens: 200 },
            computedAt: '2026-06-01T00:00:00.000Z',
            source: 'held-out-grid',
            evidence: 'fixture',
          },
        },
      },
      ['classifier/model'],
      models
    );
    expect(config?.policyOverrides).toEqual({ accuracyNoiseBand: 0.03 });
    expect(config?.policyComputed).toEqual({});
  });
});
