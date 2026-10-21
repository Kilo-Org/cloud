import { randomUUID } from 'node:crypto';
import { type UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { OpenRouterProvider } from '@kilocode/db/schema-types';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import {
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getAiSdkProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

type DirectByokKeyOwner = 'user' | 'organization';

/** The Gemini API is enabled for personal BYOK keys only, for now. */
export function getDirectByokSupportedChatApis(
  provider: DirectByokProvider,
  keyOwner: DirectByokKeyOwner
): ReadonlyArray<GatewayChatApiKind> {
  return keyOwner === 'user'
    ? provider.supported_chat_apis
    : provider.supported_chat_apis.filter(kind => kind !== 'generate_content');
}

/** Providers for `/api/v1/providers` that the general provider list lacks. */
export function getDirectByokProviderListings(): OpenRouterProvider[] {
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return providers.flatMap(({ id, provider_listing }) => {
    if (!provider_listing) return [];
    const name = DIRECT_BYOK_PROVIDERS_META[id];
    return [{ name, displayName: name, slug: id, ...provider_listing }];
  });
}

export function formatDirectByokModelId(provider: DirectByokProvider, model: DirectByokModel) {
  return (provider.id + '/' + model.id).toLowerCase();
}

function convertModel(
  provider: DirectByokProvider,
  model: DirectByokModel,
  preferredIndex: number,
  ai_sdk_provider: DirectByokModel['ai_sdk_provider']
) {
  const id = formatDirectByokModelId(provider, model);
  const name = DIRECT_BYOK_PROVIDERS_META[provider.id] + ': ' + model.name;
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name,
    created: 631148400, // our clients do not care about this field, we can fix it later if that changes
    description: '',
    context_length: model.context_length,
    architecture: {
      modality: model.flags?.includes('vision') ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(model.flags?.includes('vision') ? ['image'] : []),
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: '0.0000000',
      completion: '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: '0.00000000',
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      model.flags?.includes('reasoning') ? ['reasoning'] : []
    ),
    default_parameters: {},
    preferredIndex: model.flags?.includes('recommended') ? preferredIndex : undefined,
    hasUserByokAvailable: true,
    opencode: withLegacyVariants({
      ai_sdk_provider,
      reasoning_options:
        model.reasoning_options ??
        (model.flags?.includes('reasoning') ? getFallbackReasoningOptions(id) : undefined),
    }),
  };
}

async function getDirectByokModels(
  byokProviders: UserByokProviderId[],
  keyOwner: DirectByokKeyOwner
) {
  const firstPreferredId = (await getPreferredModels()).length;
  const enabledProviders = DIRECT_BYOK_PROVIDERS.filter(provider =>
    byokProviders.includes(provider.id)
  );
  const modelsByProvider = await Promise.all(
    enabledProviders.map(async provider => {
      const models: ReadonlyArray<DirectByokModel> = await provider.models();
      return { provider, models };
    })
  );
  let nextPreferredId = firstPreferredId;
  return modelsByProvider.flatMap(({ provider, models }) => {
    const supportsGeminiApi = getDirectByokSupportedChatApis(provider, keyOwner).includes(
      'generate_content'
    );
    return models.flatMap(model => {
      const ai_sdk_provider =
        model.ai_sdk_provider ??
        getAiSdkProvider(formatDirectByokModelId(provider, model), provider.id);
      return ai_sdk_provider === 'google' && !supportsGeminiApi
        ? []
        : [convertModel(provider, model, nextPreferredId++, ai_sdk_provider)];
    });
  });
}

export async function getDirectByokModel(requestedModel: string): Promise<{
  provider: DirectByokProvider | null;
  model: DirectByokModel | null;
}> {
  const provider = DIRECT_BYOK_PROVIDERS.find(provider =>
    requestedModel.startsWith(`${provider.id}/`)
  );
  if (!provider) {
    return { provider: null, model: null };
  }

  const model = (await provider.models()).find(
    model => formatDirectByokModelId(provider, model) === requestedModel
  );
  if (model) {
    return { provider, model };
  }

  return { provider: null, model: null };
}

export async function getDirectByokModelsForOrganization(organizationId: string) {
  const byokProviderIds = await getOrganizationByokProviderIds(readDb, organizationId);
  return byokProviderIds.length === 0
    ? []
    : await getDirectByokModels(byokProviderIds, 'organization');
}

export async function getDirectByokModelsForUser(userId: string) {
  const byokProviderIds = await getUserByokProviderIds(readDb, userId);
  return byokProviderIds.length === 0 ? [] : await getDirectByokModels(byokProviderIds, 'user');
}

export function createAiSdkProvider(directByokProvider: DirectByokProvider, apiKey: string) {
  return createOpenAICompatible({
    baseURL: directByokProvider.base_url,
    apiKey,
    name: 'openaiCompatible',
    headers:
      directByokProvider.id === 'opencode-go' ? { 'x-opencode-session': randomUUID() } : undefined,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('user-agent', COMPATIBLE_USER_AGENT);
      return fetch(url, init ? { ...init, headers } : { headers });
    },
  });
}
