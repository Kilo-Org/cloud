import { randomUUID } from 'node:crypto';
import { type UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { CustomLlmProvider, OpenRouterProvider } from '@kilocode/db/schema-types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
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
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';

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

const AI_SDK_PROVIDER_FOR_CHAT_API = {
  chat_completions: undefined,
  messages: 'anthropic',
  responses: 'openai',
} as const satisfies Record<GatewayChatApiKind, CustomLlmProvider | undefined>;

function getDirectByokAiSdkProvider(
  provider: DirectByokProvider,
  model: DirectByokModel,
  id: string
) {
  return provider.getModelChatApi
    ? AI_SDK_PROVIDER_FOR_CHAT_API[provider.getModelChatApi(model)]
    : getAiSdkProvider(id, provider.id);
}

function convertModel(
  provider: DirectByokProvider,
  model: DirectByokModel,
  preferredIndex: number
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
      ai_sdk_provider: getDirectByokAiSdkProvider(provider, model, id),
      reasoning_options:
        model.reasoning_options ??
        (model.flags?.includes('reasoning') ? getFallbackReasoningOptions(id) : undefined),
    }),
  };
}

async function getDirectByokModels(byokProviders: UserByokProviderId[]) {
  let nextPreferredId = (await getPreferredModels()).length;
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return (
    await Promise.all(
      providers
        .filter(provider => byokProviders.includes(provider.id))
        .map(async provider =>
          (await provider.models()).map(model => convertModel(provider, model, nextPreferredId++))
        )
    )
  ).flat();
}

export async function getDirectByokModel(requestedModel: string): Promise<{
  provider: DirectByokProvider | null;
  model: DirectByokModel | null;
}> {
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  const provider = providers.find(provider => requestedModel.startsWith(`${provider.id}/`));
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
  return byokProviderIds.length === 0 ? [] : await getDirectByokModels(byokProviderIds);
}

export async function getDirectByokModelsForUser(userId: string) {
  const byokProviderIds = await getUserByokProviderIds(readDb, userId);
  return byokProviderIds.length === 0 ? [] : await getDirectByokModels(byokProviderIds);
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

/**
 * An AI SDK provider for a key test against a provider whose upstream depends
 * on the stored credential. The test model must use Chat Completions.
 */
export async function createResolvedAiSdkProvider(
  directByokProvider: DirectByokProvider,
  credential: string,
  modelId: string
) {
  if (!directByokProvider.resolveUpstream) {
    return createAiSdkProvider(directByokProvider, credential);
  }
  const upstream = await directByokProvider.resolveUpstream({
    credential,
    model: { id: modelId },
    stream: false,
  });
  const awsBedrock = upstream.awsBedrock;
  return createOpenAICompatible({
    baseURL: upstream.apiUrl,
    apiKey: awsBedrock ? undefined : upstream.apiKey,
    name: 'openaiCompatible',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('user-agent', COMPATIBLE_USER_AGENT);
      if (!awsBedrock || typeof init?.body !== 'string') {
        return fetch(url, { ...init, headers });
      }
      const signedHeaders = await signBedrockRequest({
        url: String(url),
        method: init.method ?? 'POST',
        headers,
        body: init.body,
        credentials: awsBedrock,
      });
      return fetch(url, { ...init, headers: signedHeaders });
    },
  });
}
