import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { GEMMA_4_26B_A4B_IT_FREE_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  GATEWAY_MODEL_LIST_CACHE_TTL_MS,
  readGatewayModelList,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-model-lists';

// Direct requests are rejected, but kilo-auto still routes to it.
const HARDCODED_UNAVAILABLE_MODEL_IDS = [GEMMA_4_26B_A4B_IT_FREE_ID];

const getConfiguredUnavailableModelIds = createCachedFetch(
  () => readGatewayModelList('unavailable_models'),
  GATEWAY_MODEL_LIST_CACHE_TTL_MS,
  []
);

export async function getUnavailableModelIds(): Promise<ReadonlySet<string>> {
  return new Set([
    ...HARDCODED_UNAVAILABLE_MODEL_IDS,
    ...(await getConfiguredUnavailableModelIds()),
  ]);
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
