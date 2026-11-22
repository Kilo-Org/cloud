import { isKiloFundedModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-funded-model';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

/**
 * Whether a catalog-mode key may serve `modelId`: like a gateway key, it never takes over a model
 * Kilo funds (free, or the Kilo-funded auto-small fallback), and it serves only current catalog ids,
 * as the catalog can drift between syncs.
 */
export async function isByokServableCatalogModelId(modelId: string): Promise<boolean> {
  return !isKiloFundedModel(modelId) && (await isValidOpenRouterModelId(modelId));
}
