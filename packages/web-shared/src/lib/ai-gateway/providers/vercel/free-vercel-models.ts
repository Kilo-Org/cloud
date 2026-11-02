import type { StoredModel } from '@kilocode/db/schema-types';
import {
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

/**
 * Whether Vercel serves a stored language model for nothing on every route and marks it with a
 * `-free` suffix, so Kilo can treat it as a free model.
 */
export function isFreeVercelStoredModel(modelId: string, model: StoredModel): boolean {
  if (!modelId.endsWith('-free') || model.type !== 'language' || !model.catalog) return false;
  return [
    model.catalog.pricing.input,
    model.catalog.pricing.output,
    ...model.endpoints.flatMap(({ pricing }) =>
      pricing ? [pricing.prompt, pricing.completion] : []
    ),
  ].every(price => Number(price) === 0);
}

/**
 * Whether `modelId` is a free Vercel-only model (see `isFreeVercelStoredModel`). An id that
 * OpenRouter also serves is never one, because routing may send it to OpenRouter, which charges.
 */
export async function isFreeVercelModel(modelId: string): Promise<boolean> {
  if (!modelId.endsWith('-free')) return false;
  const [vercelModels, vercelModelId, isOpenRouterModel] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    mapModelIdToVercel(modelId),
    isValidOpenRouterModelId(modelId),
  ]);
  const model = vercelModels[vercelModelId];
  return !isOpenRouterModel && model !== undefined && isFreeVercelStoredModel(modelId, model);
}
