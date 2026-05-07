import type { KiloClawEnv } from '../types';
import type { NorthflankClientConfig } from './client';

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

export function northflankClientConfig(env: KiloClawEnv): NorthflankClientConfig {
  const base = getNorthflankConfig(env);
  // Always redact the edge-header secret: it's sent in request bodies
  // (buildPortSecurity) under a non-sensitive key name (`value`), so
  // redactUnknown's key-based heuristic does not catch it. Without this,
  // Northflank 4xx/5xx responses that echo the submitted payload would
  // leak the value into [northflank] api_request_failed logs and
  // NorthflankApiError bodies.
  const redactValues = [base.edgeHeaderValue].filter(value => value.length > 0);
  return { ...base, redactValues };
}
