import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import {
  createAiGatewayConfigSelector,
  readAiGatewayConfigSnapshot,
} from '@kilocode/web-shared/lib/ai-gateway/ai-gateway-config-snapshot';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { GEMMA_4_26B_A4B_IT_FREE_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';

// Direct requests are rejected, but kilo-auto still routes to it.
const HARDCODED_UNAVAILABLE_MODEL_IDS = [GEMMA_4_26B_A4B_IT_FREE_ID];

function parseUnavailableModelIds(unavailableModels: unknown): string[] {
  if (!unavailableModels) return [];
  return GatewayModelListConfigSchema.parse(unavailableModels).models;
}

/** Throws on an invalid stored list, so the cached getter keeps its last valid value. */
export async function readUnavailableModelIds(): Promise<string[]> {
  const snapshot = await readAiGatewayConfigSnapshot(readDb);
  return parseUnavailableModelIds(snapshot?.unavailable_models);
}

const getConfiguredUnavailableModelIds = createAiGatewayConfigSelector<ReadonlyArray<string>>(
  snapshot => parseUnavailableModelIds(snapshot.unavailable_models),
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
