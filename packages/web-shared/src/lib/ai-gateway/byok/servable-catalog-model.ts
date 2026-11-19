import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

/**
 * Whether a catalog-mode key may serve `modelId`: like a gateway key, it never takes over a model
 * Kilo pays for, and it serves only current catalog ids, as the catalog can drift between syncs.
 */
export async function isByokServableCatalogModelId(modelId: string): Promise<boolean> {
  return (
    !isAutoSmallFreeModel(modelId) &&
    !isFreeModel(modelId) &&
    (await isValidOpenRouterModelId(modelId))
  );
}
