import {
  OpenRouterSearchResponse,
  type OpenRouterModel,
  type OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { fetchSyncJson } from '@/lib/providers/openrouter/sync-fetch';

export async function fetchModelsForProvider(
  provider: OpenRouterProvider
): Promise<OpenRouterModel[]> {
  const searchParams = new URLSearchParams({
    providers: provider.name,
    fmt: 'cards',
  });

  const body = await fetchSyncJson(
    `Fetching models for provider ${provider.name}`,
    `https://openrouter.ai/api/frontend/v1/models/find?${searchParams}`,
    {
      method: 'GET',
      headers: ATTRIBUTION_HEADERS,
    }
  );

  const data = OpenRouterSearchResponse.parse(body);
  const models = data.data.models.filter(model => model.endpoint?.variant !== 'batch');

  return models;
}
