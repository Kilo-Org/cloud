import { VercelModelIdOverridesConfigSchema } from '@kilocode/db/schema-types';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readAiGatewayConfigRow } from '@kilocode/web-shared/lib/ai-gateway/providers/ai-gateway-config-row';
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
  Object.entries(vercelModelPrefixMapping)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([openRouterPrefix, vercelPrefix]): [string, string] => [vercelPrefix, openRouterPrefix])
);

/** Throws on an invalid stored config, so the cached getter keeps its last valid value. */
export async function readVercelModelIdOverrides(): Promise<VercelModelIdOverrides> {
  const row = await readAiGatewayConfigRow();
  if (!row?.vercelModelIdOverrides) return new Map();
  const { overrides } = VercelModelIdOverridesConfigSchema.parse(row.vercelModelIdOverrides);
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
  return (await resolveVercelModelId(modelId)).vercelModelId;
}

/**
 * The Vercel model ID for a Kilo model ID, along with the admin overrides that produced it.
 * Routing callers need both: the ID to name the model and the overrides to reverse it.
 */
export async function resolveVercelModelId(
  modelId: string
): Promise<{ vercelModelId: string; overrides: VercelModelIdOverrides }> {
  const [resolvedModelId, overrides] = await Promise.all([
    modelId.startsWith('~') ? resolveOpenRouterModelAlias(modelId) : modelId,
    getVercelModelIdOverrides(),
  ]);
  return { vercelModelId: mapResolvedModelIdToVercel(resolvedModelId, overrides), overrides };
}
