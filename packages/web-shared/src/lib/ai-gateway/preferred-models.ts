import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  selectGatewayConfigRow,
  type GatewayConfigRowDb,
} from '@kilocode/web-shared/lib/ai-gateway/select-gateway-config-row';

/** Throws on an invalid stored list, so the cached getter keeps its last valid value. */
export async function readPreferredModels(fromDb: GatewayConfigRowDb = readDb): Promise<string[]> {
  const preferredModels = await selectGatewayConfigRow(fromDb, ai_gateway_config.preferred_models);
  if (!preferredModels) return [];
  return GatewayModelListConfigSchema.parse(preferredModels).models;
}

export const getPreferredModels: () => Promise<ReadonlyArray<string>> = createCachedFetch(
  readPreferredModels,
  60_000,
  [],
  { name: 'preferredModels' }
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
