import pLimit from 'p-limit';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { normalizeModelId } from '@/lib/ai-gateway/providers/openrouter';
import { convertFromKiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  OpenRouterProvidersResponse,
  OpenRouterSearchResponse,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { modelsByProvider } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { lt } from 'drizzle-orm';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import type { StoredModel } from '@/lib/ai-gateway/providers/vercel/types';
import { EndpointsSchema, ModelsSchema } from '@/lib/ai-gateway/providers/vercel/types';
import { redisSet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS, type RedisKey } from '@/lib/redis-keys';

const ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://kilocode.ai',
  'X-Title': 'Kilo Code',
} as const;

async function fetchGatewayModels(gateway: Provider) {
  const headers = {
    ...ATTRIBUTION_HEADERS,
    authorization: `Bearer ${gateway.apiKey}`,
  };

  const modelsResponse = await fetch(`${gateway.apiUrl}/models`, {
    method: 'GET',
    headers,
  });
  if (!modelsResponse.ok) {
    throw new Error(`Fetching models from ${gateway.id} failed: ${modelsResponse.status}`);
  }
  const models = ModelsSchema.parse(await modelsResponse.json());

  const limit = pLimit(8);
  const result: Record<string, StoredModel> = {};
  await Promise.all(
    models.data.map(model =>
      limit(async () => {
        console.debug(`[fetchGatewayModels] ${gateway.id}/${model.id}`);
        const endpointsResponse = await fetch(`${gateway.apiUrl}/models/${model.id}/endpoints`, {
          method: 'GET',
          headers,
        });
        if (!endpointsResponse.ok) {
          throw new Error(
            `Fetching model endpoints for ${gateway.id}/${model.id} failed: ${endpointsResponse.status}`
          );
        }
        const endpoints = EndpointsSchema.parse(await endpointsResponse.json());
        result[model.id] = {
          ...model,
          endpoints: endpoints.data.endpoints,
        };
      })
    )
  );

  const count = Object.keys(result).length;
  if (count < 100) {
    throw new Error(`Suspicious: total number of ${gateway.id} models is ${count} < 100`);
  }

  return result;
}

async function fetchProviders(): Promise<OpenRouterProvider[]> {
  console.log('Fetching OpenRouter providers from frontend endpoint...');

  const response = await fetch(`https://openrouter.ai/api/frontend/all-providers`, {
    method: 'GET',
    headers: ATTRIBUTION_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter providers: ${response.status} ${response.statusText}`
    );
  }

  const rawData = await response.json();
  console.log(
    'Raw response structure:',
    JSON.stringify(rawData, null, 2).substring(0, 500) + '...'
  );

  const parsedData = OpenRouterProvidersResponse.parse(rawData);

  // Handle both response formats
  const providers = Array.isArray(parsedData) ? parsedData : parsedData.data;
  console.log(`Found ${providers.length} providers from endpoint`);

  return providers;
}

async function fetchModelsForProvider(provider: OpenRouterProvider): Promise<OpenRouterModel[]> {
  console.log(`Fetching models for provider: ${provider.name} (${provider.slug})`);

  // Use the frontend API endpoint with provider filter
  const searchParams = new URLSearchParams({
    providers: provider.name,
    fmt: 'cards',
  });

  console.log('GET', `https://openrouter.ai/api/frontend/models/find?${searchParams.toString()}`);

  const response = await fetch(`https://openrouter.ai/api/frontend/models/find?${searchParams}`, {
    method: 'GET',
    headers: ATTRIBUTION_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models for provider ${provider.name}: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json().then(d => OpenRouterSearchResponse.parse(d));

  console.log(`  Found ${data.data.models.length} models for provider ${provider.name}`);

  // Note: Models still contain redundant provider info in endpoint.provider_info, etc.
  // This is now available in the comprehensive providers array, but we keep it for compatibility
  return data.data.models;
}

async function syncProviders(providers: OpenRouterProvider[]) {
  if (providers.length === 0) {
    throw new Error('No providers found in OpenRouter response');
  }

  // Limit concurrent requests to 3
  const limit = pLimit(3);
  let processedCount = 0;

  console.log('Fetching models for all providers...');

  // Fetch models for each provider and collect relationships
  const providerModelData = await Promise.all(
    providers.map(provider =>
      limit(async () => {
        const models = await fetchModelsForProvider(provider);

        processedCount++;
        if (processedCount % 10 === 0) {
          console.log(`Processed ${processedCount}/${providers.length} providers...`);
        }

        return {
          provider,
          models,
        };
      })
    )
  );

  const mappedExtraModels = kiloExclusiveModels
    .filter(model => model.status === 'public' && model.inference_provider)
    .map(kfm => {
      const model = convertFromKiloExclusiveModel(kfm);
      return {
        model: {
          slug: normalizeModelId(model.id),
          name: model.name,
          author: 'Other',
          description: model.description,
          context_length: model.context_length,
          input_modalities: model.architecture.input_modalities,
          output_modalities: model.architecture.output_modalities,
          group: 'other',
          updated_at: new Date().toISOString(),
          endpoint: {
            provider_display_name: 'Other',
            is_free: !kfm.pricing,
            pricing: {
              prompt: model.pricing.prompt,
              completion: model.pricing.completion,
            },
          },
        },
        provider: kfm.inference_provider,
      };
    });

  for (const extraModel of mappedExtraModels) {
    const providerData = providerModelData.find(data => data.provider.slug === extraModel.provider);
    if (providerData) {
      console.log(
        `Found existing ${extraModel.provider} provider from OpenRouter, adding extra model ${extraModel.model.slug}`
      );
      providerData.models.splice(0, 0, extraModel.model);
    }
  }

  // Filter out providers with no models
  const filteredProviderModelData = providerModelData.filter(data => data.models.length > 0);

  // Create simplified structure with providers containing their models directly
  const normalizedProviders: NormalizedProvider[] = filteredProviderModelData.map(data => {
    // Deduplicate models within each provider by slug
    const uniqueModelsMap = new Map<string, OpenRouterModel>();
    data.models.forEach(model => {
      uniqueModelsMap.set(normalizeModelId(model.slug), model);
    });
    const uniqueModels = Array.from(uniqueModelsMap.values());

    // Sort models by name
    uniqueModels.sort((a, b) => a.name.localeCompare(b.name));

    return {
      name: data.provider.name,
      displayName: data.provider.displayName,
      slug: data.provider.slug,
      dataPolicy: {
        training: data.provider.dataPolicy.training,
        retainsPrompts: data.provider.dataPolicy.retainsPrompts,
        canPublish: data.provider.dataPolicy.canPublish,
      },
      headquarters: data.provider.headquarters,
      datacenters: data.provider.datacenters,
      icon: data.provider.icon,
      models: uniqueModels, // Use deduplicated and sorted models
    };
  });

  const allProviders = [...normalizedProviders];

  // Auto-detect providers referenced by extra models that aren't already present
  const missingProviderSlugs = new Set(
    mappedExtraModels
      .map(m => m.provider)
      .filter(
        (slug): slug is NonNullable<typeof slug> =>
          slug !== null && !allProviders.some(p => p.slug === slug)
      )
  );

  for (const providerSlug of missingProviderSlugs) {
    const displayName = providerSlug.toUpperCase();
    const iconInitials = providerSlug.slice(0, 2).toUpperCase();
    allProviders.push({
      name: displayName,
      displayName,
      slug: providerSlug,
      dataPolicy: {
        training: true,
        retainsPrompts: true,
        canPublish: false,
      },
      headquarters: 'Unknown',
      datacenters: ['Global'],
      icon: {
        url: `https://placehold.co/100?text=${iconInitials}&font=roboto`,
        className: 'rounded-sm',
      },
      models: mappedExtraModels.filter(m => m.provider === providerSlug).map(m => m.model),
    });
  }

  // Sort providers by name
  const sortedProviders = allProviders.sort((a, b) => a.name.localeCompare(b.name));

  // Calculate total models across all providers
  const totalModels = sortedProviders.reduce((sum, provider) => sum + provider.models.length, 0);

  const result: NormalizedOpenRouterResponse = {
    providers: sortedProviders,
    total_providers: sortedProviders.length,
    total_models: totalModels,
    generated_at: new Date().toISOString(),
  };

  return result;
}

async function mirrorToRedis(values: {
  providers: NormalizedOpenRouterResponse;
  openrouter: Record<string, StoredModel>;
  vercel: Record<string, StoredModel>;
  openrouterProviders: OpenRouterProvider[];
}): Promise<void> {
  const entries: [RedisKey, unknown][] = [
    [GATEWAY_METADATA_REDIS_KEYS.allProviders, values.providers],
    [GATEWAY_METADATA_REDIS_KEYS.openrouterModels, values.openrouter],
    [GATEWAY_METADATA_REDIS_KEYS.vercelModels, values.vercel],
  ];
  if (values.openrouterProviders) {
    entries.push([GATEWAY_METADATA_REDIS_KEYS.openrouterProviders, values.openrouterProviders]);
  }
  await Promise.all(entries.map(([key, value]) => redisSet(key, JSON.stringify(value))));
}

export async function syncAndStoreProviders() {
  const startTime = performance.now();

  const openrouter_data = await fetchGatewayModels(PROVIDERS.OPENROUTER);
  const vercel_data = await fetchGatewayModels(PROVIDERS.VERCEL_AI_GATEWAY);

  const openrouterProviders = await fetchProviders();
  if (openrouterProviders.length < 10) {
    throw new Error(
      `Suspicious: total number of OpenRouter API providers is ${openrouterProviders.length} < 10`
    );
  }

  const providers = await syncProviders(openrouterProviders);

  if (providers.total_providers < 10) {
    throw new Error(`Suspicious: total number of providers is ${providers.total_providers} < 10`);
  }

  if (providers.total_models < 100) {
    throw new Error(`Suspicious: total number of models is ${providers.total_models} < 100`);
  }

  const result = await db.transaction(async tx => {
    const results = await tx
      .insert(modelsByProvider)
      .values({
        data: providers,
        openrouter: openrouter_data,
        vercel: vercel_data,
      })
      .returning();
    await tx.delete(modelsByProvider).where(lt(modelsByProvider.id, results[0].id));
    return results[0];
  });

  await mirrorToRedis({
    providers,
    openrouter: openrouter_data,
    vercel: vercel_data,
    openrouterProviders,
  });

  return {
    id: result.id,
    generated_at: result.data.generated_at,
    total_models: result.data.total_models,
    total_providers: result.data.total_providers,
    time: performance.now() - startTime,
  };
}
