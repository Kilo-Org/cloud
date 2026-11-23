import { ai_gateway_config } from '@kilocode/db/schema';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import {
  DEFAULT_ORGANIZATION_FEATURES,
  GatewayOrganizationFeaturesConfigSchema,
  type OrganizationFeature,
  type OrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  selectGatewayConfigRow,
  type GatewayConfigRowDb,
} from '@kilocode/web-shared/lib/ai-gateway/select-gateway-config-row';

export async function readOrganizationFeatures(
  fromDb: GatewayConfigRowDb
): Promise<OrganizationFeatures> {
  const config = await selectGatewayConfigRow(fromDb, ai_gateway_config.config);
  if (config === undefined) return DEFAULT_ORGANIZATION_FEATURES;
  return GatewayOrganizationFeaturesConfigSchema.parse(config).organization_features;
}

export function isOrganizationFeatureEnabled(
  features: OrganizationFeatures,
  feature: OrganizationFeature,
  organizationId: string | null | undefined
): boolean {
  return !!organizationId && features[feature].includes(organizationId.toLowerCase());
}

/** The organization features for the gateway hot path, cached for one minute. */
export const getRuntimeOrganizationFeatures = createCachedFetch<OrganizationFeatures>(
  () => readOrganizationFeatures(readDb),
  60_000,
  DEFAULT_ORGANIZATION_FEATURES,
  { name: 'runtimeOrganizationFeatures' }
);
