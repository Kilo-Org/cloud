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

/** The concrete models in the preferred list; auto models route elsewhere and are not monitored. */
export async function getMonitoredModels(): Promise<string[]> {
  return (await getPreferredModels()).filter(model => !isKiloAutoModel(model));
}
