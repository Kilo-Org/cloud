import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { isGatewayUserByokEligibleModel } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

/**
 * Whether a catalog-mode endpoint may serve `modelId`: like a gateway key, it never takes over a
 * model Kilo pays for, and it serves only live catalog ids.
 */
export async function isByokEndpointCatalogModelCandidate(modelId: string): Promise<boolean> {
  return (
    !isAutoSmallFreeModel(modelId) &&
    isGatewayUserByokEligibleModel(modelId) &&
    (await isValidOpenRouterModelId(modelId))
  );
}
