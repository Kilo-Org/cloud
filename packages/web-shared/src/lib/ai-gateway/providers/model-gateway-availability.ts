import {
  OrganizationDataRegionSchema,
  type OrganizationDataRegion,
} from '@kilocode/db/schema-types';
import {
  getOpenRouterModelsFromDatabase,
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

export type ModelGatewayAvailability = {
  vercel: { available: boolean; regions: OrganizationDataRegion[] };
  openrouter: { available: boolean };
};

/** Whether each gateway serves the model, and the inference regions Vercel offers it in. */
export async function getModelGatewayAvailability(
  modelId: string
): Promise<ModelGatewayAvailability> {
  const [vercelModelId, vercelModels, vercelMetadata, openRouterModels] = await Promise.all([
    mapModelIdToVercel(modelId),
    getVercelModelsFromDatabase(),
    getVercelModelsMetadataFromDatabase(),
    getOpenRouterModelsFromDatabase(),
  ]);

  const vercelAvailable = vercelModels.has(vercelModelId);
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
