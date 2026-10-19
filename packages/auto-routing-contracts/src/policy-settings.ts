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

/**
 * The shape each setting's value must take. An override or computed value is
 * accepted only when it matches its own key's schema; it is never coerced.
 */
export const POLICY_SETTING_VALUE_SCHEMAS = {
  minAccuracy: z.number().min(0).max(1),
  accuracyNoiseBand: z.number().min(0).max(1),
  frontierMinAccuracyDelta: z.number().min(0).max(1),
  productionTokenProfile: ProductionTokenProfileSchema,
  switchHorizonTurns: z.number().int().positive(),
  switchCostFactor: z.number().min(1).max(100),
  bestAccuracySwitchThreshold: z.number().min(0).max(1),
  lowConfidenceThreshold: z.number().min(0).max(1),
  classifierRepetitions: z.number().int().min(1).max(5),
  deciderRepetitions: z.number().int().min(1).max(5),
  classifierMaxP95LatencyMs: z.number().int().positive(),
} as const satisfies Record<PolicySettingKey, z.ZodType>;

const VALUE = POLICY_SETTING_VALUE_SCHEMAS;

/** Sparse admin overrides. A missing key (or an explicit null) means "no override". */
export const PolicySettingOverridesSchema = z.object({
  minAccuracy: VALUE.minAccuracy.nullable().optional(),
  accuracyNoiseBand: VALUE.accuracyNoiseBand.nullable().optional(),
  frontierMinAccuracyDelta: VALUE.frontierMinAccuracyDelta.nullable().optional(),
  productionTokenProfile: VALUE.productionTokenProfile.nullable().optional(),
  switchHorizonTurns: VALUE.switchHorizonTurns.nullable().optional(),
  switchCostFactor: VALUE.switchCostFactor.nullable().optional(),
  bestAccuracySwitchThreshold: VALUE.bestAccuracySwitchThreshold.nullable().optional(),
  lowConfidenceThreshold: VALUE.lowConfidenceThreshold.nullable().optional(),
  classifierRepetitions: VALUE.classifierRepetitions.nullable().optional(),
  deciderRepetitions: VALUE.deciderRepetitions.nullable().optional(),
  classifierMaxP95LatencyMs: VALUE.classifierMaxP95LatencyMs.nullable().optional(),
});
export type PolicySettingOverrides = z.infer<typeof PolicySettingOverridesSchema>;

function computedRecordSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    computedAt: z.iso.datetime({ offset: true }),
    source: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
  });
}

/** Display shape of one computed record, for the admin state response. */
export const PolicySettingComputedSchema = computedRecordSchema(PolicySettingValueSchema);
export type PolicySettingComputed = z.infer<typeof PolicySettingComputedSchema>;

export const PolicySettingComputedMapSchema = z.object({
  minAccuracy: computedRecordSchema(VALUE.minAccuracy).optional(),
  accuracyNoiseBand: computedRecordSchema(VALUE.accuracyNoiseBand).optional(),
  frontierMinAccuracyDelta: computedRecordSchema(VALUE.frontierMinAccuracyDelta).optional(),
  productionTokenProfile: computedRecordSchema(VALUE.productionTokenProfile).optional(),
  switchHorizonTurns: computedRecordSchema(VALUE.switchHorizonTurns).optional(),
  switchCostFactor: computedRecordSchema(VALUE.switchCostFactor).optional(),
  bestAccuracySwitchThreshold: computedRecordSchema(VALUE.bestAccuracySwitchThreshold).optional(),
  lowConfidenceThreshold: computedRecordSchema(VALUE.lowConfidenceThreshold).optional(),
  classifierRepetitions: computedRecordSchema(VALUE.classifierRepetitions).optional(),
  deciderRepetitions: computedRecordSchema(VALUE.deciderRepetitions).optional(),
  classifierMaxP95LatencyMs: computedRecordSchema(VALUE.classifierMaxP95LatencyMs).optional(),
});
export type PolicySettingComputedMap = z.infer<typeof PolicySettingComputedMapSchema>;

function validEntries(
  raw: object,
  shape: Record<PolicySettingKey, z.ZodType>
): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const key of POLICY_SETTING_KEYS) {
    if (!(key in raw)) continue;
    const value: unknown = Reflect.get(raw, key);
    if (shape[key].safeParse(value).success) valid[key] = value;
  }
  return valid;
}

/** Stored overrides with every entry that fails its key's schema dropped. */
export function parseStoredPolicyOverrides(raw: unknown): PolicySettingOverrides | null {
  if (raw === null || typeof raw !== 'object') return null;
  return PolicySettingOverridesSchema.parse(validEntries(raw, PolicySettingOverridesSchema.shape));
}

/** Stored computed records with every entry that fails its key's schema dropped. */
export function parseStoredPolicyComputed(raw: unknown): PolicySettingComputedMap | null {
  if (raw === null || typeof raw !== 'object') return null;
  return PolicySettingComputedMapSchema.parse(
    validEntries(raw, PolicySettingComputedMapSchema.shape)
  );
}

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
  defaults: PolicySettingDefaults,
  overrides: PolicySettingOverrides | null,
  computed: PolicySettingComputedMap | null
): PolicySettingValue {
  const meta: PolicySettingMeta = POLICY_SETTINGS[key];
  if (meta.kind === 'fixed') return meta.fixed;
  return overrides?.[key] ?? computed?.[key]?.value ?? defaults[key];
}

export function resolvePolicySettings(config: PolicySettingSource): PolicySettingsState {
  const overrides = parseStoredPolicyOverrides(config.policyOverrides);
  const computed = parseStoredPolicyComputed(config.policyComputed);
  const states = {} as PolicySettingsState;
  for (const key of POLICY_SETTING_KEYS) {
    const meta: PolicySettingMeta = POLICY_SETTINGS[key];
    states[key] = {
      kind: meta.kind,
      label: meta.label,
      effective: resolveValue(key, config, overrides, computed),
      override: overrides?.[key] ?? null,
      computed: computed?.[key] ?? null,
      reason: meta.kind === 'fixed' ? meta.reason : null,
    };
  }
  return states;
}

/** Effective values in their concrete types, for read sites that build tables. */
export function resolveEffectivePolicy(config: PolicySettingSource): PolicySettingDefaults {
  const overrides = parseStoredPolicyOverrides(config.policyOverrides);
  const computed = parseStoredPolicyComputed(config.policyComputed);
  // Overrides and computed values passed their own key's schema above, defaults
  // are typed per key, and each fixed value is authored for its key.
  const value = <K extends PolicySettingKey>(key: K) =>
    resolveValue(key, config, overrides, computed) as PolicySettingDefaults[K];
  return {
    minAccuracy: value('minAccuracy'),
    accuracyNoiseBand: value('accuracyNoiseBand'),
    frontierMinAccuracyDelta: value('frontierMinAccuracyDelta'),
    productionTokenProfile: value('productionTokenProfile'),
    switchHorizonTurns: value('switchHorizonTurns'),
    switchCostFactor: value('switchCostFactor'),
    bestAccuracySwitchThreshold: value('bestAccuracySwitchThreshold'),
    lowConfidenceThreshold: value('lowConfidenceThreshold'),
    classifierRepetitions: value('classifierRepetitions'),
    deciderRepetitions: value('deciderRepetitions'),
    classifierMaxP95LatencyMs: value('classifierMaxP95LatencyMs'),
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
