import {
  getOpenRouterModelsFromDatabase,
  getVercelModelsFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

export type ModelGateway = 'vercel' | 'openrouter';

/** The gateways that serve the model. */
export async function getModelGateways(modelId: string): Promise<ModelGateway[]> {
  const [vercelModelId, vercelModels, openRouterModels] = await Promise.all([
    mapModelIdToVercel(modelId),
    getVercelModelsFromDatabase(),
    getOpenRouterModelsFromDatabase(),
  ]);

  return [
    ...(vercelModels.has(vercelModelId) ? (['vercel'] as const) : []),
    ...(openRouterModels.has(modelId) ? (['openrouter'] as const) : []),
  ];
}
