import pLimit from 'p-limit';
import { kiloFreeModels } from '@/lib/models';
import { normalizeModelId } from '@/lib/providers/openrouter';
import { convertFromKiloModel } from '@/lib/providers/kilo-free-model';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/providers/openrouter/openrouter-types';
import {
  OpenRouterProvidersResponse,
  OpenRouterSearchResponse,
} from '@/lib/providers/openrouter/openrouter-types';
import { modelsByProvider } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { lt } from 'drizzle-orm';

async function fetchProviders(): Promise<OpenRouterProvider[]> {
  console.log('Fetching OpenRouter providers from frontend endpoint...');

  const response = await fetch(`https://openrouter.ai/api/frontend/all-providers`, {
    method: 'GET',
    headers: {
      // NOTE: Changing HTTP-Referer; per OpenRouter docs it would identify us as a different app, but can be merged by Openrouter later
      'HTTP-Referer': 'https://kilocode.ai',
      'X-Title': 'Kilo Code',
    },
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
    headers: {
      // NOTE: Changing HTTP-Referer; per OpenRouter docs it would identify us as a different app, but can be merged by Openrouter later
      'HTTP-Referer': 'https://kilocode.ai',
      'X-Title': 'Kilo Code',
    },
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

export async function syncProviders() {
  // Fetch all providers
  const providers = await fetchProviders();

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

  const mappedExtraModels = kiloFreeModels
    .filter(model => model.is_enabled)
    .map(kfm => {
      const model = convertFromKiloModel(kfm);
      return {
        model: {
          slug: normalizeModelId(model.id),
          hf_slug: model.hugging_face_id || null,
          updated_at: new Date().toISOString(),
          created_at: new Date(model.created * 1000).toISOString(),
          hf_updated_at: null,
          name: model.name,
          short_name: model.name,
          author: 'Other',
          description: model.description,
          model_version_group_id: null,
          context_length: model.context_length,
          input_modalities: model.architecture.input_modalities,
          output_modalities: model.architecture.output_modalities,
          has_text_output: true,
          group: 'other',
          instruct_type: model.architecture.instruct_type,
          default_system: null,
          default_stops: [],
          hidden: false,
          router: null,
          warning_message: null,
          permaslug: model.canonical_slug,
          reasoning_config: null,
          features: null,
          default_parameters: null,
          endpoint: {
            id: model.id,
            name: model.name,
            context_length: model.context_length,
            model: {
              slug: model.id,
              hf_slug: model.hugging_face_id || null,
              updated_at: new Date().toISOString(),
              created_at: new Date(model.created * 1000).toISOString(),
              hf_updated_at: null,
              name: model.name,
              short_name: model.name,
              author: 'Other',
              description: model.description,
              model_version_group_id: null,
              context_length: model.context_length,
              input_modalities: model.architecture.input_modalities,
              output_modalities: model.architecture.output_modalities,
              has_text_output: true,
              group: 'other',
              instruct_type: model.architecture.instruct_type,
              default_system: null,
              default_stops: [],
              hidden: false,
              router: null,
              warning_message: null,
              permaslug: model.canonical_slug,
              reasoning_config: null,
              features: null,
              default_parameters: null,
            },
            model_variant_slug: model.id,
            model_variant_permaslug: model.canonical_slug,
            adapter_name: 'other',
            provider_name: 'Other',
            provider_info: {
              name: 'Other',
              displayName: 'Other',
              slug: 'other',
              baseUrl: 'https://kilo.ai',
              dataPolicy: {
                training: true,
                retainsPrompts: true,
                canPublish: false,
              },
              headquarters: 'Unknown',
              hasChatCompletions: true,
              hasCompletions: false,
              isAbortable: true,
              moderationRequired: false,
              editors: [],
              owners: [],
              adapterName: 'other',
              isMultipartSupported: true,
              statusPageUrl: null,
              byokEnabled: false,
              icon: {
                url: 'https://via.placeholder.com/32x32/000000/FFFFFF?text=S',
                className: 'rounded-sm',
              },
              ignoredProviderModels: [],
            },
            provider_display_name: 'Other',
            provider_slug: 'other',
            provider_model_id: model.id,
            quantization: null,
            variant: 'default',
            is_free: true,
            can_abort: true,
            max_prompt_tokens: model.top_provider.context_length,
            max_completion_tokens: model.top_provider.max_completion_tokens,
            max_prompt_images: null,
            max_tokens_per_image: null,
            supported_parameters: model.supported_parameters,
            is_byok: false,
            moderation_required: model.top_provider.is_moderated,
            data_policy: {
              training: true,
              retainsPrompts: true,
              canPublish: false,
            },
            pricing: {
              prompt: model.pricing.prompt,
              completion: model.pricing.completion,
              image: model.pricing.image,
              request: model.pricing.request,
              web_search: model.pricing.web_search,
              internal_reasoning: model.pricing.internal_reasoning,
              image_output: '0',
              discount: 0,
              input_cache_read: model.pricing.input_cache_read,
            },
            variable_pricings: [],
            is_hidden: false,
            is_deranked: false,
            is_disabled: false,
            supports_tool_parameters: true,
            supports_reasoning: false,
            supports_multipart: true,
            limit_rpm: null,
            limit_rpd: null,
            limit_rpm_cf: null,
            has_completions: false,
            has_chat_completions: true,
            features: null,
            provider_region: null,
          },
        },
        providers: kfm.inference_providers,
      };
    });

  for (const extraModel of mappedExtraModels) {
    for (const provider of extraModel.providers) {
      const providerData = providerModelData.find(data => data.provider.slug === provider);
      if (providerData) {
        console.log(
          `Found existing ${provider} provider from OpenRouter, adding extra model ${extraModel.model.slug}`
        );
        providerData.models.push(extraModel.model);
      }
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
  if (!allProviders.some(provider => provider.name.toLowerCase() === 'stealth')) {
    allProviders.push({
      name: 'Stealth',
      displayName: 'Stealth',
      slug: 'stealth',
      dataPolicy: {
        training: true,
        retainsPrompts: true,
        canPublish: false,
      },
      headquarters: 'Unknown',
      datacenters: ['Global'],
      icon: {
        url: 'https://placehold.co/100?text=St&font=roboto',
        className: 'rounded-sm',
      },
      models: mappedExtraModels.filter(m => m.providers.includes('stealth')).map(m => m.model),
    });
  }
  if (!allProviders.some(provider => provider.name.toLowerCase() === 'martian')) {
    allProviders.push({
      name: 'Martian',
      displayName: 'Martian',
      slug: 'martian',
      dataPolicy: {
        training: true,
        retainsPrompts: true,
        canPublish: false,
      },
      headquarters: 'Unknown',
      datacenters: ['Global'],
      icon: {
        url: 'https://placehold.co/100?text=Ma&font=roboto',
        className: 'rounded-sm',
      },
      models: mappedExtraModels.filter(m => m.providers.includes('martian')).map(m => m.model),
    });
  }
  if (!allProviders.some(provider => provider.name.toLowerCase() === 'corethink')) {
    allProviders.push({
      name: 'CoreThink',
      displayName: 'CoreThink',
      slug: 'corethink',
      dataPolicy: {
        training: true,
        retainsPrompts: true,
        canPublish: false,
      },
      headquarters: 'Unknown',
      datacenters: ['Global'],
      icon: {
        url: 'https://placehold.co/100?text=CT&font=roboto',
        className: 'rounded-sm',
      },
      models: mappedExtraModels.filter(m => m.providers.includes('corethink')).map(m => m.model),
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

export async function syncAndStoreProviders() {
  const providers = await syncProviders();

  if (providers.total_providers < 10) {
    throw new Error(`Suspicious: total number of providers is ${providers.total_providers} < 10`);
  }

  if (providers.total_models < 100) {
    throw new Error(`Suspicious: total number of models is ${providers.total_models} < 100`);
  }

  const result = await db.transaction(async () => {
    const results = await db.insert(modelsByProvider).values({ data: providers }).returning();
    await db.delete(modelsByProvider).where(lt(modelsByProvider.id, results[0].id));
    return results[0];
  });

  return {
    id: result.id,
    generated_at: result.data.generated_at,
    total_models: result.data.total_models,
    total_providers: result.data.total_providers,
  };
}
