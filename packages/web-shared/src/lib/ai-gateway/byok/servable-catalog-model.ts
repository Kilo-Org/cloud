import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  getVercelModelsFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isValidVercelModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';

/**
 * Whether `modelId` is a current Kilo catalog id: an OpenRouter id, or the OpenRouter-style id the
 * catalog lists a model under that only Vercel AI Gateway serves. Unlike `isValidVercelModelId`,
 * an unavailable Vercel model list admits no Vercel-only id.
 */
export async function isKiloCatalogModelId(modelId: string): Promise<boolean> {
  if (await isValidOpenRouterModelId(modelId)) return true;
  return (await getVercelModelsFromDatabase()).size > 0 && (await isValidVercelModelId(modelId));
}

/**
 * Whether a catalog-mode key may serve `modelId`: like a gateway key, it never takes over a model
 * Kilo pays for, and it serves only current catalog ids, as the catalog can drift between syncs.
 */
export async function isByokServableCatalogModelId(modelId: string): Promise<boolean> {
  return (
    !isAutoSmallFreeModel(modelId) && !isFreeModel(modelId) && (await isKiloCatalogModelId(modelId))
  );
}
