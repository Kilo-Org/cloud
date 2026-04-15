import 'server-only';

import { getEnvVariable } from '@/lib/dotenvx';

export type PersonalKiloClawProviderRolloutConfig = {
  rolloutAvailable: boolean;
  northflankEnabled: boolean;
  northflankTrafficPercent: number;
};

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = getEnvVariable(name);
  if (value == null || value === '') return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;

  throw new Error(`${name} must be true, false, 1, or 0`);
}

function parsePercentEnv(name: string, defaultValue: number): number {
  const value = getEnvVariable(name);
  if (value == null || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be an integer between 0 and 100`);
  }

  return parsed;
}

export function getKiloClawNorthflankRolloutAvailable(): boolean {
  return parseBooleanEnv('KILOCLAW_NORTHFLANK_ROLLOUT_AVAILABLE', false);
}

export function getPersonalKiloClawProviderRolloutConfig(): PersonalKiloClawProviderRolloutConfig {
  return {
    rolloutAvailable: getKiloClawNorthflankRolloutAvailable(),
    northflankEnabled: parseBooleanEnv('KILOCLAW_PERSONAL_NORTHFLANK_ENABLED', false),
    northflankTrafficPercent: parsePercentEnv('KILOCLAW_PERSONAL_NORTHFLANK_TRAFFIC_PERCENT', 0),
  };
}
