import {
  OpenRouterSearchResponse,
  type OpenRouterModel,
  type OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import {
  getMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

export function openRouterProviderModelsSource(
  providerName: string
): MetadataSource<OpenRouterModel[]> {
  const searchParams = new URLSearchParams({
    providers: providerName,
    fmt: 'cards',
  });
  return {
    url: `https://openrouter.ai/api/frontend/v1/models/find?${searchParams}`,
    headers: () => ATTRIBUTION_HEADERS,
    parse: raw =>
      OpenRouterSearchResponse.parse(raw).data.models.filter(
        model => model.endpoint?.variant !== 'batch'
      ),
  };
}

export function fetchModelsForProvider(provider: OpenRouterProvider): Promise<OpenRouterModel[]> {
  return getMetadata(openRouterProviderModelsSource(provider.name), readDb);
}
