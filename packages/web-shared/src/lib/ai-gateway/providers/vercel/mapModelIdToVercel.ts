import { ai_gateway_config } from '@kilocode/db/schema';
import { VercelModelIdOverridesConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  AUTO_SMALL_FREE_MODEL_UPSTREAM_ID,
  isAutoSmallFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

export type VercelModelIdOverrides = ReadonlyMap<string, string>;

const vercelModelPrefixMapping: Record<string, string | undefined> = {
  'bytedance-seed': 'bytedance',
  mistralai: 'mistral',
  qwen: 'alibaba',
  'x-ai': 'spacexai',
  'z-ai': 'zai',
};

const openRouterModelPrefixMapping: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(vercelModelPrefixMapping).map(([openRouterPrefix, vercelPrefix]) => [
    vercelPrefix,
    openRouterPrefix,
  ])
);

/** Throws on an invalid stored config, so the cached getter keeps its last valid value. */
export async function readVercelModelIdOverrides(): Promise<VercelModelIdOverrides> {
  const [row] = await readDb
    .select({ config: ai_gateway_config.vercel_model_id_overrides })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return new Map();
  const { overrides } = VercelModelIdOverridesConfigSchema.parse(row.config);
  return new Map(overrides.map(o => [o.openrouter_model_id, o.vercel_model_id]));
}

export const getVercelModelIdOverrides = createCachedFetch<VercelModelIdOverrides>(
  readVercelModelIdOverrides,
  60_000,
  new Map(),
  { name: 'vercelModelIdOverrides' }
);

function replaceModelPrefix(
  modelId: string,
  prefixMapping: Record<string, string | undefined>
): string {
  const slashIndex = modelId.indexOf('/');
  if (slashIndex < 0) {
    return modelId;
  }
  const prefix = prefixMapping[modelId.slice(0, slashIndex)];
  return prefix ? prefix + modelId.slice(slashIndex) : modelId;
}

/** The Vercel model ID derived from the built-in rules, ignoring admin overrides. */
export function mapResolvedModelIdToVercelWithoutOverrides(modelId: string): string {
  const internalId = isAutoSmallFreeModel(modelId) ? AUTO_SMALL_FREE_MODEL_UPSTREAM_ID : modelId;
  return replaceModelPrefix(internalId, vercelModelPrefixMapping);
}

export function mapResolvedModelIdToVercel(
  modelId: string,
  overrides: VercelModelIdOverrides
): string {
  return overrides.get(modelId) ?? mapResolvedModelIdToVercelWithoutOverrides(modelId);
}

/**
 * The OpenRouter-style ID that `mapResolvedModelIdToVercel` maps to `vercelModelId`, so a model
 * listed under it routes back to that Vercel model. Undefined when no candidate maps back.
 */
export function mapVercelModelIdToOpenRouter(
  vercelModelId: string,
  overrides: VercelModelIdOverrides
): string | undefined {
  const overriddenIds = [...overrides]
    .filter(([, overrideVercelModelId]) => overrideVercelModelId === vercelModelId)
    .map(([openRouterModelId]) => openRouterModelId);
  return [...overriddenIds, replaceModelPrefix(vercelModelId, openRouterModelPrefixMapping)].find(
    openRouterModelId => mapResolvedModelIdToVercel(openRouterModelId, overrides) === vercelModelId
  );
}

export async function mapModelIdToVercel(modelId: string): Promise<string> {
  const [resolvedModelId, overrides] = await Promise.all([
    modelId.startsWith('~') ? resolveOpenRouterModelAlias(modelId) : modelId,
    getVercelModelIdOverrides(),
  ]);
  return mapResolvedModelIdToVercel(resolvedModelId, overrides);
}
