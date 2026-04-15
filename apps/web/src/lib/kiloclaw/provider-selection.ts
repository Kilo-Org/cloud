import { createHash } from 'node:crypto';
import type { KiloClawProviderId } from '@/lib/kiloclaw/types';
import type { KiloClawProviderRolloutConfig } from '@/lib/kiloclaw/provider-rollout-config';

function rolloutBucket(key: string): number {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % 100;
}

function selectProviderFromRollout(params: {
  enabled: boolean;
  percent: number;
  key: string;
}): KiloClawProviderId {
  if (!params.enabled || params.percent <= 0) return 'fly';
  if (params.percent >= 100) return 'northflank';
  return rolloutBucket(params.key) < params.percent ? 'northflank' : 'fly';
}

export function selectOrgKiloClawProvider(params: {
  organizationId: string;
  userId: string;
  northflankConfig: KiloClawProviderRolloutConfig;
}): KiloClawProviderId {
  return selectProviderFromRollout({
    enabled: params.northflankConfig.enabled,
    percent: params.northflankConfig.organizationTrafficPercent,
    key: `org:${params.organizationId}:user:${params.userId}`,
  });
}

export function selectPersonalKiloClawProvider(params: {
  userId: string;
  northflankConfig: KiloClawProviderRolloutConfig;
}): KiloClawProviderId {
  return selectProviderFromRollout({
    enabled: params.northflankConfig.enabled,
    percent: params.northflankConfig.personalTrafficPercent,
    key: `personal:user:${params.userId}`,
  });
}

export const providerSelectionTestUtils = {
  rolloutBucket,
};
