import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import * as z from 'zod';

export const OPENROUTER_NATIVE_PROVIDER_SLUG = 'openrouter';

export type OpenRouterPublicModel = {
  id: string;
  name: string;
  description: string;
  created?: number;
  context_length: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
  };
  alias_target?: { slug: string } | null;
};

const OpenRouterPublicModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z
    .string()
    .nullish()
    .transform(value => value ?? ''),
  created: z.number().optional(),
  context_length: z.number(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).default([]),
      output_modalities: z.array(z.string()).default([]),
    })
    .default({ input_modalities: [], output_modalities: [] }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  alias_target: z.object({ slug: z.string() }).nullish(),
});

const OpenRouterPublicModelsResponseSchema = z.object({
  data: z.array(OpenRouterPublicModelSchema),
});

const FIRST_PARTY_PROVIDER_SLUG_BY_AUTHOR: Record<string, string> = {
  google: 'google-ai-studio',
  'x-ai': 'xai',
};

type ProviderModels = Array<{
  provider: OpenRouterProvider;
  models: OpenRouterModel[];
}>;

function authorFromModelId(modelId: string): string {
  const id = modelId.startsWith('~') ? modelId.slice(1) : modelId;
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(0, slash) : id;
}

function catalogEndpoint(model: OpenRouterPublicModel, providerDisplayName: string) {
  const prompt = Number.parseFloat(model.pricing.prompt);
  const completion = Number.parseFloat(model.pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
    return null;
  }
  const isFree = prompt === 0 && completion === 0;
  return {
    provider_display_name: providerDisplayName,
    is_free: isFree,
    pricing: {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
    },
    ...(isFree ? { data_policy: { training: true, retainsPrompts: true } } : {}),
  };
}

function toCatalogModel(
  model: OpenRouterPublicModel,
  providerDisplayName: string,
  endpoint: OpenRouterModel['endpoint']
): OpenRouterModel {
  return {
    slug: model.id,
    name: model.name,
    author: authorFromModelId(model.id),
    description: model.description,
    context_length: model.context_length,
    input_modalities: [...model.architecture.input_modalities],
    output_modalities: [...model.architecture.output_modalities],
    group: authorFromModelId(model.id),
    updated_at:
      model.created === undefined
        ? new Date().toISOString()
        : new Date(model.created * 1000).toISOString(),
    endpoint,
  };
}

function hasModel(models: OpenRouterModel[], slug: string): boolean {
  return models.some(model => model.slug === slug);
}

function ensureOpenRouterProvider(providerModelData: ProviderModels): {
  provider: OpenRouterProvider;
  models: OpenRouterModel[];
} {
  const existing = providerModelData.find(
    entry => entry.provider.slug === OPENROUTER_NATIVE_PROVIDER_SLUG
  );
  if (existing) return existing;

  const created = {
    provider: {
      name: 'OpenRouter',
      displayName: 'OpenRouter',
      slug: OPENROUTER_NATIVE_PROVIDER_SLUG,
      dataPolicy: {
        training: false,
        retainsPrompts: false,
        canPublish: false,
      },
      headquarters: 'US',
      icon: {
        url: 'https://openrouter.ai/favicon.ico',
      },
    },
    models: [] as OpenRouterModel[],
  };
  providerModelData.push(created);
  return created;
}

function injectAlias(providerModelData: ProviderModels, model: OpenRouterPublicModel) {
  const targetSlug = model.alias_target?.slug;
  let injected = false;
  if (targetSlug) {
    const normalizedTarget = normalizeModelId(targetSlug);
    for (const entry of providerModelData) {
      const target = entry.models.find(
        candidate => normalizeModelId(candidate.slug) === normalizedTarget
      );
      if (!target || hasModel(entry.models, model.id)) continue;
      entry.models.unshift(
        toCatalogModel(model, entry.provider.displayName, target.endpoint ?? null)
      );
      injected = true;
    }
  }
  if (injected) return;

  const author = authorFromModelId(model.id);
  const fallbackSlug = FIRST_PARTY_PROVIDER_SLUG_BY_AUTHOR[author] ?? author;
  const fallback = providerModelData.find(entry => entry.provider.slug === fallbackSlug);
  if (!fallback || hasModel(fallback.models, model.id)) return;
  fallback.models.unshift(
    toCatalogModel(
      model,
      fallback.provider.displayName,
      catalogEndpoint(model, fallback.provider.displayName)
    )
  );
}

function injectOpenRouterNative(providerModelData: ProviderModels, model: OpenRouterPublicModel) {
  const entry = ensureOpenRouterProvider(providerModelData);
  if (hasModel(entry.models, model.id)) return;
  entry.models.unshift(
    toCatalogModel(
      model,
      entry.provider.displayName,
      catalogEndpoint(model, entry.provider.displayName)
    )
  );
}

export function injectOpenRouterCatalogOnlyModels(
  providerModelData: ProviderModels,
  publicModels: ReadonlyArray<OpenRouterPublicModel>
) {
  for (const model of publicModels) {
    if (model.id.startsWith('openrouter/')) {
      injectOpenRouterNative(providerModelData, model);
      continue;
    }
    if (model.id.startsWith('~')) {
      injectAlias(providerModelData, model);
    }
  }
}

export async function fetchOpenRouterPublicModels(): Promise<OpenRouterPublicModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers: ATTRIBUTION_HEADERS,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter public models: ${response.status} ${response.statusText}`
    );
  }
  return OpenRouterPublicModelsResponseSchema.parse(await response.json()).data;
}
