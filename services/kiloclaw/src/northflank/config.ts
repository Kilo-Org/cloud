import type { KiloClawEnv } from '../types';

export const NORTHFLANK_API_BASE = 'https://api.northflank.com/v1';

export type NorthflankConfig = {
  apiToken: string;
  apiBase: string;
  teamId: string | null;
  region: string;
  deploymentPlan: string;
  storageClassName: string;
  storageAccessMode: string;
  volumeSizeMb: number;
  ephemeralStorageMb: number;
  edgeHeaderName: string;
  edgeHeaderValue: string;
  imagePathTemplate: string | null;
  imageCredentialsId: string | null;
};

function requiredEnv(env: KiloClawEnv, key: keyof KiloClawEnv): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${String(key)} is not configured`);
  }
  return value;
}

function optionalEnv(env: KiloClawEnv, key: keyof KiloClawEnv): string | null {
  const value = env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positiveIntegerEnv(
  env: KiloClawEnv,
  key: keyof KiloClawEnv,
  defaultValue: number
): number {
  const value = optionalEnv(env, key);
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${String(key)} must be a positive integer`);
  }
  return parsed;
}

export function getNorthflankConfig(env: KiloClawEnv): NorthflankConfig {
  return {
    apiToken: requiredEnv(env, 'NF_API_TOKEN'),
    apiBase: optionalEnv(env, 'NF_API_BASE') ?? NORTHFLANK_API_BASE,
    teamId: optionalEnv(env, 'NF_TEAM_ID'),
    region: requiredEnv(env, 'NF_REGION'),
    deploymentPlan: requiredEnv(env, 'NF_DEPLOYMENT_PLAN'),
    storageClassName: optionalEnv(env, 'NF_STORAGE_CLASS_NAME') ?? 'nf-multi-rw',
    storageAccessMode: optionalEnv(env, 'NF_STORAGE_ACCESS_MODE') ?? 'ReadWriteMany',
    volumeSizeMb: positiveIntegerEnv(env, 'NF_VOLUME_SIZE_MB', 10240),
    ephemeralStorageMb: positiveIntegerEnv(env, 'NF_EPHEMERAL_STORAGE_MB', 10240),
    edgeHeaderName: requiredEnv(env, 'NF_EDGE_HEADER_NAME'),
    edgeHeaderValue: requiredEnv(env, 'NF_EDGE_HEADER_VALUE'),
    imagePathTemplate: optionalEnv(env, 'NF_IMAGE_PATH_TEMPLATE'),
    imageCredentialsId: optionalEnv(env, 'NF_IMAGE_CREDENTIALS_ID'),
  };
}
