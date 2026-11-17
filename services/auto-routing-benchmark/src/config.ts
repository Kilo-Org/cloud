import type {
  AutoRouter,
  BenchmarkConfig,
  BenchmarkPlatformModel,
  ProductionTokenProfile,
} from '@kilocode/auto-routing-contracts';
import {
  parseStoredPolicyComputed,
  parseStoredPolicyOverrides,
  POLICY_SETTING_VALUE_DEFAULTS,
} from '@kilocode/auto-routing-contracts';
import { getConfigRows, replaceConfig, type ConfigDeciderModelRow } from './db';

// Retain nullable legacy columns for rolling deploys, but never read saved efforts.
export function toDeciderModelRows(models: BenchmarkPlatformModel[]): ConfigDeciderModelRow[] {
  return models.map(m => ({
    model: m.id,
    variant: null,
    reasoning_effort: null,
  }));
}

// Maps the three normalized config tables to the BenchmarkConfig contract.
// Null when no admin has saved a config yet — the worker never fabricates
// one, and runs cannot start until a config exists.
export function mapConfigRows(
  // The seven fixed policy columns are legacy: they are not read here, and the
  // effective value comes from the policy setting's fixed constant.
  configRow: {
    router?: AutoRouter;
    accuracy_noise_band?: number;
    min_accuracy: number;
    production_token_profile?: ProductionTokenProfile | null;
    switch_horizon_turns?: number | null;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    // Stored JSON; entries that fail their key's schema are ignored on read.
    policy_overrides?: unknown;
    policy_computed?: unknown;
    updated_at: string;
    updated_by: string | null;
  } | null,
  classifierModels: string[],
  deciderModelRows: ConfigDeciderModelRow[]
): BenchmarkConfig | null {
  const deciderModels = deciderModelRows.map(r => ({ id: r.model }));

  if (configRow === null || classifierModels.length === 0 || deciderModels.length === 0) {
    return null;
  }

  return {
    router: configRow.router ?? 'efficient',
    accuracyNoiseBand:
      configRow.accuracy_noise_band ?? POLICY_SETTING_VALUE_DEFAULTS.accuracyNoiseBand,
    classifierModels,
    deciderModels,
    minAccuracy: configRow.min_accuracy,
    productionTokenProfile: configRow.production_token_profile ?? null,
    switchHorizonTurns: configRow.switch_horizon_turns ?? null,
    benchmarkUserId: configRow.benchmark_user_id,
    benchmarkOrgId: configRow.benchmark_org_id,
    policyOverrides: parseStoredPolicyOverrides(configRow.policy_overrides),
    policyComputed: parseStoredPolicyComputed(configRow.policy_computed),
    updatedAt: configRow.updated_at,
    updatedBy: configRow.updated_by,
  };
}

export async function getBenchmarkConfig(
  db: D1Database,
  router: AutoRouter = 'efficient'
): Promise<BenchmarkConfig | null> {
  const { config, classifierModels, deciderModels } = await getConfigRows(db, router);
  return mapConfigRows(config, classifierModels, deciderModels);
}

export async function saveBenchmarkConfig(
  db: D1Database,
  config: BenchmarkConfig,
  updatedBy: string | null
): Promise<BenchmarkConfig> {
  const updatedAt = new Date().toISOString();
  const stamped: BenchmarkConfig = { ...config, updatedAt, updatedBy };
  const existing = await getBenchmarkConfig(db, config.router);

  const deciderModelRows = toDeciderModelRows(config.deciderModels);

  await replaceConfig(
    db,
    {
      min_accuracy: config.minAccuracy,
      accuracy_noise_band: config.accuracyNoiseBand,
      production_token_profile: config.productionTokenProfile,
      switch_horizon_turns: config.switchHorizonTurns,
      benchmark_user_id: config.benchmarkUserId,
      benchmark_org_id: config.benchmarkOrgId,
      policy_overrides: config.policyOverrides ?? null,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    config.classifierModels,
    deciderModelRows,
    config.router
  );

  // The computed map is server-owned: an admin save must not clear it.
  return { ...stamped, policyComputed: existing?.policyComputed ?? null };
}
