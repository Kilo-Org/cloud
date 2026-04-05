import { generateMock } from '@anatine/zod-mock';
import type { OpenRouterProvider } from '@/components/models/util';
import type { OpenRouterModel } from '@/lib/providers/openrouter/openrouter-types';
import { OpenRouterModel as OpenRouterModelSchema } from '@/lib/providers/openrouter/openrouter-types';
import { mockDataRng as rng, randomChoice, randomBoolean, randomInt } from './random';
import {
  MODELS,
  PROVIDER_DESCRIPTION_ADJECTIVES,
  PROVIDER_HEADQUARTERS,
  PROVIDERS,
} from './constants';

function toDisplayName(slug: string): string {
  if (!slug) return slug;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function generateModel(): OpenRouterModel {
  const base = generateMock(OpenRouterModelSchema) as Partial<OpenRouterModel> | null | undefined;
  const modelName = randomChoice(rng, MODELS);

  // Ensure all required fields have defaults
  const inputModalities =
    Array.isArray(base?.input_modalities) && base.input_modalities.length > 0
      ? base.input_modalities
      : ['text'];
  const outputModalities =
    Array.isArray(base?.output_modalities) && base.output_modalities.length > 0
      ? base.output_modalities
      : ['text'];

  return {
    slug: base?.slug ?? `${randomChoice(rng, PROVIDERS)}/${modelName}`,
    hf_slug: base?.hf_slug ?? null,
    updated_at: base?.updated_at ?? new Date().toISOString(),
    created_at: base?.created_at ?? new Date().toISOString(),
    hf_updated_at: base?.hf_updated_at ?? null,
    name: modelName,
    short_name: modelName.split('-')[0] || modelName,
    author: toDisplayName(randomChoice(rng, PROVIDERS)),
    description:
      base?.description ?? `A ${randomChoice(rng, PROVIDER_DESCRIPTION_ADJECTIVES)} AI model`,
    model_version_group_id: base?.model_version_group_id ?? null,
    context_length: base?.context_length ?? 100000,
    input_modalities: inputModalities,
    output_modalities: outputModalities,
    has_text_output: base?.has_text_output ?? true,
    group: base?.group ?? 'default',
    instruct_type: base?.instruct_type ?? null,
    default_system: base?.default_system ?? null,
    default_stops: Array.isArray(base?.default_stops) ? base.default_stops : [],
    hidden: base?.hidden ?? false,
    router: base?.router ?? null,
    warning_message: base?.warning_message ?? null,
    permaslug: base?.permaslug ?? `${randomChoice(rng, PROVIDERS)}/${modelName}`,
    reasoning_config: base?.reasoning_config ?? null,
    features: base?.features ?? null,
    default_parameters: base?.default_parameters ?? null,
    endpoint: base?.endpoint ?? null,
  };
}

export function generateProvider(): OpenRouterProvider {
  const slug = randomChoice(rng, PROVIDERS);
  const providerName = toDisplayName(slug);
  const adapterName = slug; // Derive from provider slug

  return {
    name: providerName,
    displayName: providerName,
    slug,
    baseUrl: `https://api.${slug}.com`,
    dataPolicy: {
      training: randomBoolean(rng),
      retainsPrompts: randomBoolean(rng),
      canPublish: randomBoolean(rng),
    },
    headquarters: randomChoice(rng, PROVIDER_HEADQUARTERS),
    hasChatCompletions: randomBoolean(rng),
    hasCompletions: randomBoolean(rng),
    isAbortable: randomBoolean(rng),
    moderationRequired: randomBoolean(rng),
    editors: [],
    owners: [],
    adapterName,
    isMultipartSupported: randomBoolean(rng),
    statusPageUrl: randomBoolean(rng) ? `https://status.${slug}.com` : null,
    byokEnabled: randomBoolean(rng),
    ignoredProviderModels: [],
    models: Array.from({ length: randomInt(rng, 1, 3) }, generateModel),
  };
}

export function generateAnthropicProvider(): OpenRouterProvider {
  const provider = generateProvider();

  return {
    ...provider,
    name: 'Anthropic',
    displayName: 'Anthropic',
    slug: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    dataPolicy: {
      training: false,
      retainsPrompts: true,
      canPublish: false,
    },
    headquarters: 'US',
    adapterName: 'anthropic',
    models: Array.from({ length: randomInt(rng, 2, 3) }, generateModel),
  };
}

export const mockAnthropicProvider = generateAnthropicProvider();
