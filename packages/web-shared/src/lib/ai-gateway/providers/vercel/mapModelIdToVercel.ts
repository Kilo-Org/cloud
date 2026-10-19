import { ai_gateway_config } from '@kilocode/db/schema';
import { VercelModelIdOverridesConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

export type VercelModelIdOverrides = ReadonlyMap<string, string>;

const vercelModelPrefixMapping: Record<string, string | undefined> = {
  mistralai: 'mistral',
  qwen: 'alibaba',
  'x-ai': 'spacexai',
  'z-ai': 'zai',
};

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
  new Map()
);

/** The Vercel model ID derived from the built-in rules, ignoring admin overrides. */
export function mapResolvedModelIdToVercelWithoutOverrides(modelId: string): string {
  const internalId =
    kiloExclusiveModels.find(
      m =>
        m.public_id === modelId &&
        (m.provider.id === 'vercel' || m.flags.includes('vercel-routing'))
    )?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const vercelPrefix = vercelModelPrefixMapping[internalId.slice(0, slashIndex)];
  return vercelPrefix ? vercelPrefix + internalId.slice(slashIndex) : internalId;
}

export function mapResolvedModelIdToVercel(
  modelId: string,
  overrides: VercelModelIdOverrides
): string {
  return overrides.get(modelId) ?? mapResolvedModelIdToVercelWithoutOverrides(modelId);
}

export async function mapModelIdToVercel(modelId: string): Promise<string> {
  const [resolvedModelId, overrides] = await Promise.all([
    modelId.startsWith('~') ? resolveOpenRouterModelAlias(modelId) : modelId,
    getVercelModelIdOverrides(),
  ]);
  return mapResolvedModelIdToVercel(resolvedModelId, overrides);
}
