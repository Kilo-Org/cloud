import { OrganizationDataRegionSchema, type OrganizationDataRegion } from '@kilocode/db/schema-types';
import {
  getOpenRouterModelsFromDatabase,
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { isVercelRoutingOptOut } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

export type ModelGatewayAvailability = {
  vercel: { available: boolean; regions: OrganizationDataRegion[] };
  openrouter: { available: boolean };
};

/**
 * Whether each gateway serves the model. A model opted out of Vercel routing counts as unavailable
 * on Vercel, because Kilo never sends it there.
 */
export async function getModelGatewayAvailability(
  modelId: string
): Promise<ModelGatewayAvailability> {
  const [vercelModelId, vercelModels, vercelMetadata, openRouterModels, routingConfig] =
    await Promise.all([
      mapModelIdToVercel(modelId),
      getVercelModelsFromDatabase(),
      getVercelModelsMetadataFromDatabase(),
      getOpenRouterModelsFromDatabase(),
      getRuntimeGatewayRoutingConfig(),
    ]);

  const vercelAvailable =
    vercelModels.has(vercelModelId) &&
    !isVercelRoutingOptOut(modelId, routingConfig.vercelOptOutModels);
  const regions = vercelAvailable
    ? OrganizationDataRegionSchema.options.filter(region =>
        vercelMetadata[vercelModelId]?.regions?.includes(region)
      )
    : [];

  return {
    vercel: { available: vercelAvailable, regions },
    openrouter: { available: openRouterModels.has(modelId) },
  };
}
