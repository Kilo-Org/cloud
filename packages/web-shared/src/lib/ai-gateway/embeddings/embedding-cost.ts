import type { StoredModel } from '@kilocode/db';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getVercelModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { normalizeKiloEmbeddingModelId } from './kilo-embedding-models';

/**
 * Only catalog entries that mark themselves as embedding models can price an
 * embedding request, so an id that also names a text model cannot lend its
 * token price to it.
 */
function isEmbeddingCatalogModel(model: StoredModel): boolean {
  if (model.type !== undefined) return model.type === 'embedding';
  return model.architecture?.output_modalities.includes('embeddings') ?? false;
}

/**
 * The highest prompt price, in USD per token, catalogued for an embedding model.
 *
 * An embedding response does not say which route served it, so the ceiling is
 * the highest price any of the model's catalogued routes charges.
 */
export function embeddingPromptPriceUsdPerToken(model: StoredModel | undefined): number | null {
  if (!model || !isEmbeddingCatalogModel(model)) return null;
  let ceiling: number | null = null;
  for (const endpoint of model.endpoints) {
    const promptPrice = Number(endpoint.pricing?.prompt);
    if (!Number.isFinite(promptPrice) || promptPrice < 0) continue;
    ceiling = ceiling === null ? promptPrice : Math.max(ceiling, promptPrice);
  }
  return ceiling;
}

/**
 * Prices embedding usage from the gateway model catalogs. The serving gateway's
 * catalog is consulted first; the other catalog prices the same upstream models
 * and covers ids the first one does not list. Returns null when no catalogued
 * embedding model matches.
 */
export async function resolveEmbeddingCatalogCost_mUsd(params: {
  provider: ProviderId;
  modelIds: readonly string[];
  promptTokens: number;
}): Promise<number | null> {
  const { provider, modelIds, promptTokens } = params;
  if (promptTokens <= 0 || modelIds.length === 0) return null;
  if (provider !== 'openrouter' && provider !== 'vercel') return null;

  const [openRouterModels, vercelModels] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getVercelModelsMetadataFromDatabase(),
  ]);
  const catalogs: StoredModelMap[] =
    provider === 'vercel' ? [vercelModels, openRouterModels] : [openRouterModels, vercelModels];

  for (const modelId of modelIds) {
    const normalized = normalizeKiloEmbeddingModelId(modelId);
    if (!normalized) continue;
    for (const catalog of catalogs) {
      const promptPrice = embeddingPromptPriceUsdPerToken(catalog[normalized]);
      if (promptPrice !== null) return toMicrodollars(promptPrice * promptTokens);
    }
  }
  return null;
}
