import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import {
  createAiGatewayConfigSelector,
  readAiGatewayConfigSnapshot,
} from '@kilocode/web-shared/lib/ai-gateway/ai-gateway-config-snapshot';
import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';

function parsePreferredModels(preferredModels: unknown): string[] {
  if (!preferredModels) return [];
  return GatewayModelListConfigSchema.parse(preferredModels).models;
}

/** Throws on an invalid stored list, so the cached getter keeps its last valid value. */
export async function readPreferredModels(): Promise<string[]> {
  const snapshot = await readAiGatewayConfigSnapshot(readDb);
  return parsePreferredModels(snapshot?.preferred_models);
}

export const getPreferredModels = createAiGatewayConfigSelector<ReadonlyArray<string>>(
  snapshot => parsePreferredModels(snapshot.preferred_models),
  []
);

/**
 * The concrete models in the preferred list; auto models route elsewhere and are not monitored.
 * Throws when the list is empty, so health checks and stats syncs fail instead of silently
 * monitoring nothing.
 */
export async function getMonitoredModels(): Promise<string[]> {
  const monitoredModels = (await getPreferredModels()).filter(model => !isKiloAutoModel(model));
  if (monitoredModels.length === 0) {
    throw new Error(
      'No monitored models: ai_gateway_config.preferred_models has no concrete models or could not be read'
    );
  }
  return monitoredModels;
}
