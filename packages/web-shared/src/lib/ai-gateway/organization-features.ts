import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import {
  DEFAULT_ORGANIZATION_FEATURES,
  GatewayOrganizationFeaturesConfigSchema,
  type OrganizationFeature,
  type OrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';

export async function readOrganizationFeatures(fromDb: typeof db): Promise<OrganizationFeatures> {
  const [row] = await fromDb
    .select({ config: ai_gateway_config.config })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row) return DEFAULT_ORGANIZATION_FEATURES;
  return GatewayOrganizationFeaturesConfigSchema.parse(row.config).organization_features;
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
