import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';

/** Throws on an invalid stored list, so the cached getter keeps its last valid value. */
export async function readUnavailableModelIds(): Promise<string[]> {
  const [row] = await readDb
    .select({ unavailable_models: ai_gateway_config.unavailable_models })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.unavailable_models) return [];
  return GatewayModelListConfigSchema.parse(row.unavailable_models).models;
}

const getConfiguredUnavailableModelIds = createCachedFetch(readUnavailableModelIds, 60_000, [], {
  name: 'unavailableModelIds',
});

export async function getUnavailableModelIds(): Promise<ReadonlySet<string>> {
  return new Set([AUTO_SMALL_TARGET_MODELS.free, ...(await getConfiguredUnavailableModelIds())]);
}

export async function isUnavailableModel(modelId: string): Promise<boolean> {
  return (await getUnavailableModelIds()).has(modelId);
}

// Only free-model families gate free endpoints; non-free unavailable models
// (e.g. region-restricted) must not suppress a family's free endpoints.
export function familyHasUnavailableFreeModel(
  unavailableModelIds: ReadonlySet<string>,
  modelId: string
): boolean {
  const family = normalizeModelId(modelId);
  return [...unavailableModelIds].some(
    unavailableModelId =>
      unavailableModelId.endsWith(':free') && normalizeModelId(unavailableModelId) === family
  );
}
