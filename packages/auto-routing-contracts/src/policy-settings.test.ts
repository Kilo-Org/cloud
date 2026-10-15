import { describe, expect, it } from 'vitest';
import { BenchmarkConfigSchema } from './benchmark';
import {
  POLICY_SETTING_KEYS,
  resolveEffectivePolicy,
  resolvePolicySettings,
  type PolicySettingSource,
} from './policy-settings';

const computedAt = '2026-06-01T00:00:00.000Z';

const base: PolicySettingSource = {
  minAccuracy: 0.7,
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0.1,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  lowConfidenceThreshold: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: null,
  policyOverrides: null,
  policyComputed: null,
};

describe('policy setting resolution', () => {
  it('resolves override, then computed, then the stored default', () => {
    const states = resolvePolicySettings({
      ...base,
      policyOverrides: { minAccuracy: 0.95 },
      policyComputed: {
        minAccuracy: { value: 0.6, computedAt, source: 'held-out-grid', evidence: 'fixture' },
        accuracyNoiseBand: {
          value: 0.02,
          computedAt,
          source: 'held-out-grid',
          evidence: 'fixture',
        },
      },
    });

    expect(states.minAccuracy).toMatchObject({
      kind: 'auto',
      effective: 0.95,
      override: 0.95,
      computed: { value: 0.6 },
    });
    expect(states.accuracyNoiseBand).toMatchObject({ effective: 0.02, override: null });
    expect(states.productionTokenProfile).toMatchObject({ kind: 'auto', effective: null });
    expect(states.switchHorizonTurns).toMatchObject({ kind: 'auto', effective: null });

    expect(
      resolveEffectivePolicy({ ...base, policyOverrides: { minAccuracy: 0.95 } })
    ).toMatchObject({ minAccuracy: 0.95, accuracyNoiseBand: 0.05 });
  });

  it('treats a null override as cleared and keeps fixed settings fixed', () => {
    const states = resolvePolicySettings({
      ...base,
      policyOverrides: { minAccuracy: null, switchCostFactor: 99 },
      policyComputed: {
        minAccuracy: { value: 0.6, computedAt, source: 'held-out-grid', evidence: 'fixture' },
      },
    });

    expect(states.minAccuracy).toMatchObject({ effective: 0.6, override: null });
    expect(states.switchCostFactor).toMatchObject({
      kind: 'fixed',
      effective: 3,
      reason: expect.any(String),
    });
    expect(states.frontierMinAccuracyDelta).toMatchObject({ kind: 'fixed', effective: 0 });
  });

  it('parses a stored config written before policy settings existed', () => {
    const parsed = BenchmarkConfigSchema.parse({
      router: 'efficient',
      classifierModels: ['classifier/a'],
      deciderModels: [{ id: 'platform/a' }],
      minAccuracy: 0.7,
      accuracyNoiseBand: 0.05,
      frontierMinAccuracyDelta: 0,
      maxConcurrency: 100,
      benchmarkUserId: null,
      switchCostFactor: 3,
      updatedAt: null,
      updatedBy: null,
    });

    expect(parsed.policyOverrides).toBeUndefined();
    expect(parsed.policyComputed).toBeUndefined();

    const states = resolvePolicySettings(parsed);
    expect(Object.keys(states).sort()).toEqual([...POLICY_SETTING_KEYS].sort());
    expect(states.minAccuracy).toMatchObject({ kind: 'auto', effective: 0.7, computed: null });
    expect(states.accuracyNoiseBand).toMatchObject({ effective: 0.05 });
  });
});
