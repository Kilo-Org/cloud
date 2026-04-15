import 'server-only';

import { db } from '@/lib/drizzle';
import { kiloclaw_providers } from '@kilocode/db/schema';
import {
  KiloClawProvider,
  type KiloClawProvider as KiloClawProviderId,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';

export type KiloClawProviderRolloutConfig = {
  provider: KiloClawProviderId;
  enabled: boolean;
  personalTrafficPercent: number;
  organizationTrafficPercent: number;
};

function defaultKiloClawProviderRolloutConfig(
  provider: KiloClawProviderId
): KiloClawProviderRolloutConfig {
  if (provider === KiloClawProvider.Fly) {
    return {
      provider,
      enabled: true,
      personalTrafficPercent: 100,
      organizationTrafficPercent: 100,
    };
  }

  return {
    provider,
    enabled: false,
    personalTrafficPercent: 0,
    organizationTrafficPercent: 0,
  };
}

function normalizeKiloClawProviderRolloutConfig(row: {
  provider: KiloClawProviderId;
  enabled: boolean;
  personal_traffic_percent: number;
  organization_traffic_percent: number;
}): KiloClawProviderRolloutConfig {
  return {
    provider: row.provider,
    enabled: row.enabled,
    personalTrafficPercent: row.personal_traffic_percent,
    organizationTrafficPercent: row.organization_traffic_percent,
  };
}

export async function getKiloClawProviderRolloutConfig(
  provider: KiloClawProviderId
): Promise<KiloClawProviderRolloutConfig> {
  const [row] = await db
    .select({
      provider: kiloclaw_providers.provider,
      enabled: kiloclaw_providers.enabled,
      personal_traffic_percent: kiloclaw_providers.personal_traffic_percent,
      organization_traffic_percent: kiloclaw_providers.organization_traffic_percent,
    })
    .from(kiloclaw_providers)
    .where(eq(kiloclaw_providers.provider, provider));

  if (!row) return defaultKiloClawProviderRolloutConfig(provider);
  return normalizeKiloClawProviderRolloutConfig(row);
}

export async function updateKiloClawProviderRolloutConfig(input: {
  provider: KiloClawProviderId;
  enabled: boolean;
  personalTrafficPercent: number;
  organizationTrafficPercent: number;
}): Promise<KiloClawProviderRolloutConfig> {
  const [row] = await db
    .insert(kiloclaw_providers)
    .values({
      provider: input.provider,
      enabled: input.enabled,
      personal_traffic_percent: input.personalTrafficPercent,
      organization_traffic_percent: input.organizationTrafficPercent,
    })
    .onConflictDoUpdate({
      target: kiloclaw_providers.provider,
      set: {
        enabled: input.enabled,
        personal_traffic_percent: input.personalTrafficPercent,
        organization_traffic_percent: input.organizationTrafficPercent,
      },
    })
    .returning({
      provider: kiloclaw_providers.provider,
      enabled: kiloclaw_providers.enabled,
      personal_traffic_percent: kiloclaw_providers.personal_traffic_percent,
      organization_traffic_percent: kiloclaw_providers.organization_traffic_percent,
    });

  if (!row) throw new Error('Failed to update KiloClaw provider rollout config');
  return normalizeKiloClawProviderRolloutConfig(row);
}
