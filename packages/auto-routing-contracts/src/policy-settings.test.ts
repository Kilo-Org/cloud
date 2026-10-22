import { describe, expect, it } from 'vitest';
import { BenchmarkConfigSchema } from './benchmark';
import {
  POLICY_SETTING_KEYS,
  POLICY_SETTING_VALUE_SCHEMAS,
  POLICY_SETTINGS,
  parseStoredPolicyComputed,
  parseStoredPolicyOverrides,
  resolveEffectivePolicy,
  resolvePolicySettings,
  type PolicySettingMeta,
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
      policyOverrides: parseStoredPolicyOverrides({ minAccuracy: null, switchCostFactor: 99 }),
      policyComputed: {
        minAccuracy: { value: 0.6, computedAt, source: 'held-out-grid', evidence: 'fixture' },
      },
    });

    expect(states.minAccuracy).toMatchObject({ effective: 0.6, override: null });
    expect(states.switchCostFactor).toMatchObject({
      kind: 'fixed',
      effective: 3,
      override: null,
      computed: null,
      reason: expect.any(String),
    });
    expect(states.frontierMinAccuracyDelta).toMatchObject({
      kind: 'fixed',
      effective: 0,
      override: null,
      computed: null,
    });
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

  it('rejects an override whose value does not fit its own setting', () => {
    const config = {
      router: 'efficient',
      classifierModels: ['classifier/a'],
      deciderModels: [{ id: 'platform/a' }],
      minAccuracy: 0.7,
      benchmarkUserId: null,
      switchCostFactor: 3,
      updatedAt: null,
      updatedBy: null,
    };
    for (const policyOverrides of [
      { minAccuracy: { uncachedInputTokens: 1000, cachedInputTokens: 200 } },
      { minAccuracy: 1.5 },
      { productionTokenProfile: 0.7 },
      { switchHorizonTurns: 2.5 },
    ]) {
      expect(BenchmarkConfigSchema.safeParse({ ...config, policyOverrides }).success).toBe(false);
    }
    expect(
      BenchmarkConfigSchema.parse({
        ...config,
        policyOverrides: {
          minAccuracy: 0.8,
          accuracyNoiseBand: null,
          productionTokenProfile: { uncachedInputTokens: 1000, cachedInputTokens: 200 },
        },
      }).policyOverrides
    ).toEqual({
      minAccuracy: 0.8,
      accuracyNoiseBand: null,
      productionTokenProfile: { uncachedInputTokens: 1000, cachedInputTokens: 200 },
    });
  });

  it('ignores stored entries that fail their own setting instead of coercing them', () => {
    const storedOverrides: unknown = {
      minAccuracy: { uncachedInputTokens: 1000, cachedInputTokens: 200 },
      accuracyNoiseBand: 0.02,
      // Valid for its own value schema, but a fixed setting cannot be overridden.
      switchCostFactor: 9,
    };
    const storedComputed: unknown = {
      minAccuracy: { value: 'high', computedAt, source: 'held-out-grid', evidence: 'fixture' },
      productionTokenProfile: { value: 0.5, computedAt, source: 'production-usage', evidence: 'x' },
      switchHorizonTurns: { value: 7, computedAt, source: 'production-usage', evidence: 'x' },
      bestAccuracySwitchThreshold: {
        value: 0.5,
        computedAt,
        source: 'held-out-grid',
        evidence: 'fixed settings are never computed',
      },
    };
    const overrides = parseStoredPolicyOverrides(storedOverrides);
    const computed = parseStoredPolicyComputed(storedComputed);

    expect(overrides).toEqual({ accuracyNoiseBand: 0.02 });
    expect(computed).toEqual({
      switchHorizonTurns: { value: 7, computedAt, source: 'production-usage', evidence: 'x' },
    });
    expect(
      resolveEffectivePolicy({ ...base, policyOverrides: overrides, policyComputed: computed })
    ).toMatchObject({
      minAccuracy: 0.7,
      accuracyNoiseBand: 0.02,
      productionTokenProfile: null,
      switchHorizonTurns: 7,
    });
  });

  it('authors every fixed value to fit its own setting', () => {
    for (const key of POLICY_SETTING_KEYS) {
      const meta: PolicySettingMeta = POLICY_SETTINGS[key];
      if (meta.kind !== 'fixed' || meta.fixed === null) continue;
      expect(POLICY_SETTING_VALUE_SCHEMAS[key].safeParse(meta.fixed).success).toBe(true);
    }
  });
});
