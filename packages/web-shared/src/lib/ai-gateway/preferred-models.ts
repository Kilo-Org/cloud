import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  GATEWAY_MODEL_LIST_CACHE_TTL_MS,
  readGatewayModelList,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-model-lists';

export const getPreferredModels: () => Promise<ReadonlyArray<string>> = createCachedFetch(
  () => readGatewayModelList('preferred_models'),
  GATEWAY_MODEL_LIST_CACHE_TTL_MS,
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
