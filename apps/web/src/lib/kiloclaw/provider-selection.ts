import { createHash } from 'node:crypto';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import type { KiloClawProviderId } from '@/lib/kiloclaw/types';
import type { PersonalKiloClawProviderRolloutConfig } from '@/lib/kiloclaw/provider-rollout-config';

function rolloutBucket(key: string): number {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % 100;
}

function selectProviderFromRollout(params: {
  enabled: boolean;
  percent: number;
  rolloutAvailable: boolean;
  key: string;
}): KiloClawProviderId {
  if (!params.rolloutAvailable || !params.enabled || params.percent <= 0) return 'fly';
  if (params.percent >= 100) return 'northflank';
  return rolloutBucket(params.key) < params.percent ? 'northflank' : 'fly';
}

export function selectOrgKiloClawProvider(params: {
  organizationId: string;
  userId: string;
  organizationSettings: OrganizationSettings | null | undefined;
  rolloutAvailable: boolean;
}): KiloClawProviderId {
  return selectProviderFromRollout({
    enabled: params.organizationSettings?.kiloclaw_northflank_enabled === true,
    percent: params.organizationSettings?.kiloclaw_northflank_traffic_percent ?? 0,
    rolloutAvailable: params.rolloutAvailable,
    key: `org:${params.organizationId}:user:${params.userId}`,
  });
}

export function selectPersonalKiloClawProvider(params: {
  userId: string;
  personalRolloutConfig: PersonalKiloClawProviderRolloutConfig;
}): KiloClawProviderId {
  return selectProviderFromRollout({
    enabled: params.personalRolloutConfig.northflankEnabled,
    percent: params.personalRolloutConfig.northflankTrafficPercent,
    rolloutAvailable: params.personalRolloutConfig.rolloutAvailable,
    key: `personal:user:${params.userId}`,
  });
}

export const providerSelectionTestUtils = {
  rolloutBucket,
};
