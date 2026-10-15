import * as z from 'zod';
import { ProductionTokenProfileSchema, type ProductionTokenProfile } from './routing-table';

/**
 * Every policy setting an admin can see on the router Policy tab.
 *
 * `auto` settings are recomputed daily by the benchmark worker and may be
 * overridden; `fixed` settings are read-only constants. The effective value
 * resolves override ?? computed ?? default.
 */
export const POLICY_SETTING_KEYS = [
  'minAccuracy',
  'accuracyNoiseBand',
  'frontierMinAccuracyDelta',
  'productionTokenProfile',
  'switchHorizonTurns',
  'switchCostFactor',
  'bestAccuracySwitchThreshold',
  'lowConfidenceThreshold',
  'classifierRepetitions',
  'deciderRepetitions',
  'classifierMaxP95LatencyMs',
] as const;

export const PolicySettingKeySchema = z.enum(POLICY_SETTING_KEYS);
export type PolicySettingKey = (typeof POLICY_SETTING_KEYS)[number];

export const PolicySettingValueSchema = z.union([
  z.number(),
  ProductionTokenProfileSchema,
  z.null(),
]);
export type PolicySettingValue = number | ProductionTokenProfile | null;

export type PolicySettingMeta =
  | { kind: 'auto'; label: string }
  | { kind: 'fixed'; label: string; fixed: PolicySettingValue; reason: string };

export const POLICY_SETTINGS = {
  minAccuracy: { kind: 'auto', label: 'Minimum accuracy' },
  accuracyNoiseBand: { kind: 'auto', label: 'Accuracy noise band' },
  frontierMinAccuracyDelta: {
    kind: 'fixed',
    label: 'Frontier minimum accuracy delta',
    fixed: 0,
    reason:
      'The frontier router computes its own minimum accuracy from the frontier pool, so no delta is added on top.',
  },
  productionTokenProfile: { kind: 'auto', label: 'Production token profile' },
  switchHorizonTurns: { kind: 'auto', label: 'Switch horizon (turns)' },
  switchCostFactor: {
    kind: 'fixed',
    label: 'Switch cost factor',
    fixed: 3,
    reason:
      'Session switching economics are not observable in the held-out single-request benchmark, so this stays a fixed serving constant.',
  },
  bestAccuracySwitchThreshold: {
    kind: 'fixed',
    label: 'Best accuracy switch threshold',
    fixed: 0.05,
    reason:
      'Session switching economics are not observable in the held-out single-request benchmark, so this stays a fixed serving constant.',
  },
  lowConfidenceThreshold: {
    kind: 'fixed',
    label: 'Low-confidence threshold',
    fixed: null,
    reason:
      'Benchmark cases record no classifier confidence, so there is no measured basis for a threshold; the low-confidence fallback stays off.',
  },
  classifierRepetitions: {
    kind: 'fixed',
    label: 'Classifier repetitions',
    fixed: 1,
    reason:
      'Repetitions change measurement noise, not the routing outcome the optimizer scores, so they stay at one.',
  },
  deciderRepetitions: {
    kind: 'fixed',
    label: 'Decider repetitions',
    fixed: 1,
    reason:
      'Repetitions change measurement noise, not the routing outcome the optimizer scores, so they stay at one.',
  },
  classifierMaxP95LatencyMs: {
    kind: 'fixed',
    label: 'Classifier max p95 latency (ms)',
    fixed: null,
    reason:
      'The classifier winner is chosen on accuracy and cost; a latency gate is an ops guard with no measured basis.',
  },
} as const satisfies Record<PolicySettingKey, PolicySettingMeta>;

export type PolicySettingKind = PolicySettingMeta['kind'];

/** Sparse admin overrides. A missing key (or an explicit null) means "no override". */
export const PolicySettingOverridesSchema = z.partialRecord(
  PolicySettingKeySchema,
  PolicySettingValueSchema
);
export type PolicySettingOverrides = Partial<Record<PolicySettingKey, PolicySettingValue>>;

export const PolicySettingComputedSchema = z.object({
  value: PolicySettingValueSchema,
  computedAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
});
export type PolicySettingComputed = z.infer<typeof PolicySettingComputedSchema>;

export const PolicySettingComputedMapSchema = z.partialRecord(
  PolicySettingKeySchema,
  PolicySettingComputedSchema
);
export type PolicySettingComputedMap = Partial<Record<PolicySettingKey, PolicySettingComputed>>;

export const PolicySettingStateSchema = z.object({
  kind: z.enum(['auto', 'fixed']),
  label: z.string(),
  effective: PolicySettingValueSchema,
  override: PolicySettingValueSchema.nullable(),
  computed: PolicySettingComputedSchema.nullable(),
  reason: z.string().nullable(),
});
export type PolicySettingState = z.infer<typeof PolicySettingStateSchema>;

export const PolicySettingsStateSchema = z.record(PolicySettingKeySchema, PolicySettingStateSchema);
export type PolicySettingsState = Record<PolicySettingKey, PolicySettingState>;

/** The stored config values a policy setting falls back to when nothing is computed. */
export type PolicySettingDefaults = {
  minAccuracy: number;
  accuracyNoiseBand: number;
  frontierMinAccuracyDelta: number;
  productionTokenProfile: ProductionTokenProfile | null;
  switchHorizonTurns: number | null;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  lowConfidenceThreshold: number | null;
  classifierRepetitions: number;
  deciderRepetitions: number;
  classifierMaxP95LatencyMs: number | null;
};

export type PolicySettingSource = PolicySettingDefaults & {
  policyOverrides?: PolicySettingOverrides | null;
  policyComputed?: PolicySettingComputedMap | null;
};

function resolveValue(
  key: PolicySettingKey,
  meta: PolicySettingMeta,
  defaults: PolicySettingDefaults,
  overrides: PolicySettingOverrides | null,
  computed: PolicySettingComputedMap | null
): PolicySettingValue {
  if (meta.kind === 'fixed') return meta.fixed;
  const override = overrides?.[key] ?? null;
  if (override !== null) return override;
  const record = computed?.[key] ?? null;
  if (record !== null) return record.value;
  return defaults[key];
}

export function resolvePolicySettings(config: PolicySettingSource): PolicySettingsState {
  const overrides = config.policyOverrides ?? null;
  const computed = config.policyComputed ?? null;
  const states = {} as PolicySettingsState;
  for (const key of POLICY_SETTING_KEYS) {
    const meta = POLICY_SETTINGS[key];
    states[key] = {
      kind: meta.kind,
      label: meta.label,
      effective: resolveValue(key, meta, config, overrides, computed),
      override: overrides?.[key] ?? null,
      computed: computed?.[key] ?? null,
      reason: meta.kind === 'fixed' ? meta.reason : null,
    };
  }
  return states;
}

/** Effective values in their concrete types, for read sites that build tables. */
export function resolveEffectivePolicy(config: PolicySettingSource): PolicySettingDefaults {
  const s = resolvePolicySettings(config);
  return {
    minAccuracy: typeof s.minAccuracy.effective === 'number' ? s.minAccuracy.effective : 0,
    accuracyNoiseBand:
      typeof s.accuracyNoiseBand.effective === 'number' ? s.accuracyNoiseBand.effective : 0,
    frontierMinAccuracyDelta:
      typeof s.frontierMinAccuracyDelta.effective === 'number'
        ? s.frontierMinAccuracyDelta.effective
        : 0,
    productionTokenProfile:
      s.productionTokenProfile.effective !== null &&
      typeof s.productionTokenProfile.effective === 'object'
        ? s.productionTokenProfile.effective
        : null,
    switchHorizonTurns:
      typeof s.switchHorizonTurns.effective === 'number' ? s.switchHorizonTurns.effective : null,
    switchCostFactor:
      typeof s.switchCostFactor.effective === 'number' ? s.switchCostFactor.effective : 0,
    bestAccuracySwitchThreshold:
      typeof s.bestAccuracySwitchThreshold.effective === 'number'
        ? s.bestAccuracySwitchThreshold.effective
        : 0,
    lowConfidenceThreshold:
      typeof s.lowConfidenceThreshold.effective === 'number'
        ? s.lowConfidenceThreshold.effective
        : null,
    classifierRepetitions:
      typeof s.classifierRepetitions.effective === 'number' ? s.classifierRepetitions.effective : 1,
    deciderRepetitions:
      typeof s.deciderRepetitions.effective === 'number' ? s.deciderRepetitions.effective : 1,
    classifierMaxP95LatencyMs:
      typeof s.classifierMaxP95LatencyMs.effective === 'number'
        ? s.classifierMaxP95LatencyMs.effective
        : null,
  };
}

/**
 * Production auto-request usage used to derive the token profile and the
 * switch horizon. Computed by the web app from Postgres `microdollar_usage`
 * and read by the benchmark worker's daily re-evaluation.
 */
export const ProductionAutoMetricsSchema = z.object({
  windowHours: z.number().int().positive(),
  sampleRequests: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  medianTurnsPerSession: z.number().positive().nullable(),
});
export type ProductionAutoMetrics = z.infer<typeof ProductionAutoMetricsSchema>;

export const ProductionAutoMetricsResponseSchema = z.object({
  metrics: ProductionAutoMetricsSchema.nullable(),
});
export type ProductionAutoMetricsResponse = z.infer<typeof ProductionAutoMetricsResponseSchema>;
