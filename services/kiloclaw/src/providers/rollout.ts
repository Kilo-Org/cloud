import { z } from 'zod';
import { ProviderIdSchema, type ProviderId } from '../schemas/instance-config';

export const PROVIDER_ROLLOUT_KV_KEY = 'provider-rollout';
export const NORTHFLANK_ROLLOUT_AVAILABLE = true;

const NorthflankRolloutSchema = z.object({
  personalTrafficPercent: z.number().int().min(0).max(100),
  organizationTrafficPercent: z.number().int().min(0).max(100),
  enabledOrganizationIds: z.array(z.string().uuid()),
});

export const ProviderRolloutConfigSchema = z.object({
  northflank: NorthflankRolloutSchema,
});

export type NorthflankRollout = z.infer<typeof NorthflankRolloutSchema>;
export type ProviderRolloutConfig = z.infer<typeof ProviderRolloutConfigSchema>;
export type ProviderRolloutSource = 'kv' | 'default';

type TextKVReader = {
  get(key: string, type: 'text'): Promise<string | null>;
};

type TextKVWriter = {
  put(key: string, value: string): Promise<void>;
};

export const DEFAULT_PROVIDER_ROLLOUT_CONFIG = {
  northflank: {
    personalTrafficPercent: 0,
    organizationTrafficPercent: 0,
    enabledOrganizationIds: [],
  },
} satisfies ProviderRolloutConfig;

export function providerRolloutAvailability() {
  return {
    northflank: NORTHFLANK_ROLLOUT_AVAILABLE,
  };
}

export async function readProviderRolloutConfig(
  kv: TextKVReader
): Promise<{ config: ProviderRolloutConfig; source: ProviderRolloutSource }> {
  let raw: string | null = null;
  try {
    raw = await kv.get(PROVIDER_ROLLOUT_KV_KEY, 'text');
  } catch {
    return { config: DEFAULT_PROVIDER_ROLLOUT_CONFIG, source: 'default' };
  }

  if (!raw) return { config: DEFAULT_PROVIDER_ROLLOUT_CONFIG, source: 'default' };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { config: DEFAULT_PROVIDER_ROLLOUT_CONFIG, source: 'default' };
  }

  const parsedConfig = ProviderRolloutConfigSchema.safeParse(parsedJson);
  if (!parsedConfig.success) return { config: DEFAULT_PROVIDER_ROLLOUT_CONFIG, source: 'default' };

  return { config: parsedConfig.data, source: 'kv' };
}

export async function writeProviderRolloutConfig(
  kv: TextKVWriter,
  config: ProviderRolloutConfig
): Promise<void> {
  const parsed = ProviderRolloutConfigSchema.parse(config);
  await kv.put(PROVIDER_ROLLOUT_KV_KEY, JSON.stringify(parsed));
}

async function rolloutBucket(key: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return new DataView(digest).getUint32(0) % 100;
}

async function selectProviderFromRollout(params: {
  available: boolean;
  percent: number;
  key: string;
}): Promise<ProviderId> {
  if (!params.available || params.percent <= 0) return 'fly';
  if (params.percent >= 100) return 'northflank';
  return (await rolloutBucket(params.key)) < params.percent ? 'northflank' : 'fly';
}

function resolveDevelopmentDefaultProvider(params: {
  workerEnv?: string;
  defaultProvider?: string;
}): ProviderId | null {
  if (params.workerEnv !== 'development') return null;

  const parsed = ProviderIdSchema.safeParse(params.defaultProvider);
  return parsed.success ? parsed.data : null;
}

export async function selectProviderForProvision(params: {
  kv: TextKVReader;
  userId: string;
  orgId?: string | null;
  workerEnv?: string;
  defaultProvider?: string;
}): Promise<ProviderId> {
  const developmentDefault = resolveDevelopmentDefaultProvider(params);
  if (developmentDefault) return developmentDefault;

  const { config } = await readProviderRolloutConfig(params.kv);
  const orgId = params.orgId ?? null;
  if (orgId && !config.northflank.enabledOrganizationIds.includes(orgId)) return 'fly';

  const percent = orgId
    ? config.northflank.organizationTrafficPercent
    : config.northflank.personalTrafficPercent;
  const key = orgId ? `org:${orgId}:user:${params.userId}` : `personal:user:${params.userId}`;

  return selectProviderFromRollout({
    available: NORTHFLANK_ROLLOUT_AVAILABLE,
    percent,
    key,
  });
}

export const providerRolloutTestUtils = {
  rolloutBucket,
};
