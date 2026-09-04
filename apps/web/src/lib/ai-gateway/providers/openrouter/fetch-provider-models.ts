import {
  OpenRouterSearchResponse,
  type OpenRouterModel,
  type OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';

export async function fetchModelsForProvider(
  provider: OpenRouterProvider
): Promise<OpenRouterModel[]> {
  console.log(`Fetching models for provider: ${provider.name} (${provider.slug})`);

  const searchParams = new URLSearchParams({
    providers: provider.name,
    fmt: 'cards',
  });

  const response = await fetch(
    `https://openrouter.ai/api/frontend/v1/models/find?${searchParams}`,
    {
      method: 'GET',
      headers: ATTRIBUTION_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models for provider ${provider.name}: ${response.status} ${response.statusText}`
    );
  }

  const data = OpenRouterSearchResponse.parse(await response.json());
  const models = data.data.models.filter(
    model =>
      model.endpoint?.variant !== 'batch' &&
      !model.endpoint?.model_variant_slug?.endsWith(':batch') &&
      !model.slug.endsWith(':batch')
  );

  console.log(`  Found ${models.length} models for provider ${provider.name}`);

  return models;
}
