import { randomUUID } from 'node:crypto';
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
  getEnabledByokProviders,
  type ByokOwner,
  type EnabledByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getPrimaryCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/catalog-models';
import {
  getOpenRouterModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
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
    description: model.description ?? '',
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

/** The chat APIs `provider` serves `model` over, known without the stored credential. */
export function getDirectByokModelChatApis(
  provider: DirectByokProvider,
  model: DirectByokModel
): ReadonlyArray<GatewayChatApiKind> {
  return provider.getModelChatApi ? [provider.getModelChatApi(model)] : provider.supportedChatApis;
}

function findDirectByokProvider(providerId: string): DirectByokProvider | undefined {
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return providers.find(provider => provider.id === providerId);
}

/** Catalog mode needs models.dev data to map upstream models to catalog ids. */
export function supportsCatalogMode(providerId: string): boolean {
  return findDirectByokProvider(providerId)?.models_dev_id !== undefined;
}

export type DirectByokCatalogEntry = { catalogModelId: string; model: DirectByokModel };

/** The catalog ids a key of this provider serves in catalog mode, with the model serving each. */
export async function listDirectByokCatalogModels(
  providerId: string
): Promise<DirectByokCatalogEntry[]> {
  const provider = findDirectByokProvider(providerId);
  if (!provider?.models_dev_id) return [];
  const entries: DirectByokCatalogEntry[] = [];
  for (const [catalogModelId, model] of getPrimaryCatalogModels(await provider.models())) {
    if (await isLiveCatalogModelId(catalogModelId)) entries.push({ catalogModelId, model });
  }
  return entries;
}

/**
 * Catalog mode is only offered while the provider maps at least one model to a catalog id;
 * otherwise a key in catalog mode would serve nothing.
 */
export async function offersCatalogMode(providerId: string): Promise<boolean> {
  return (await listDirectByokCatalogModels(providerId)).length > 0;
}

function isCatalogModeKey(key: EnabledByokProvider): boolean {
  return key.serveCatalogModels && supportsCatalogMode(key.providerId);
}

// The catalog can drift between syncs, so a stored mapping only counts while its id is current.
// Kilo-exclusive models are never served from a user's key.
async function isLiveCatalogModelId(catalogModelId: string): Promise<boolean> {
  return !isKiloExclusiveModel(catalogModelId) && (await isValidOpenRouterModelId(catalogModelId));
}

/** The catalog id that replaces `model`'s bespoke id in catalog mode, or null when unmapped. */
export async function getDirectByokCatalogModelId(model: DirectByokModel): Promise<string | null> {
  const catalogModelId = model.catalog_model_id;
  return catalogModelId && (await isLiveCatalogModelId(catalogModelId)) ? catalogModelId : null;
}

export type DirectByokCatalogModel = { provider: DirectByokProvider; model: DirectByokModel };

/**
 * The primary model of each provider that serves `catalogModelId`, in provider order. A latest
 * alias (`~vendor/family-latest`) is served by the models that serve its current target.
 */
export async function findDirectByokCatalogModels(
  catalogModelId: string
): Promise<DirectByokCatalogModel[]> {
  const targetModelId = await resolveOpenRouterModelAlias(catalogModelId);
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  const candidates = await Promise.all(
    providers.map(async provider => {
      if (!provider.models_dev_id) return [];
      const model = getPrimaryCatalogModels(await provider.models()).get(targetModelId);
      return model ? [{ provider, model }] : [];
    })
  );
  const found = candidates.flat();
  if (found.length === 0 || !(await isLiveCatalogModelId(catalogModelId))) return [];
  if (targetModelId !== catalogModelId && !(await isLiveCatalogModelId(targetModelId))) return [];
  return found;
}

async function addLatestAliasModelIds(modelIds: Set<string>): Promise<void> {
  if (modelIds.size === 0) return;
  const storedModels = await getOpenRouterModelsMetadataFromDatabase();
  for (const [modelId, storedModel] of Object.entries(storedModels)) {
    const targetModelId = storedModel.alias_target?.slug;
    if (
      modelId.startsWith('~') &&
      targetModelId &&
      modelIds.has(targetModelId) &&
      (await isLiveCatalogModelId(modelId))
    ) {
      modelIds.add(modelId);
    }
  }
}

async function getCatalogModeModelIds(keys: EnabledByokProvider[]): Promise<ReadonlySet<string>> {
  const modelIds = new Set<string>();
  for (const key of keys.filter(isCatalogModeKey)) {
    for (const { catalogModelId } of await listDirectByokCatalogModels(key.providerId)) {
      modelIds.add(catalogModelId);
    }
  }
  await addLatestAliasModelIds(modelIds);
  return modelIds;
}

/** Catalog ids the owner's catalog-mode keys serve. */
export async function getDirectByokCatalogModelIds(owner: ByokOwner): Promise<ReadonlySet<string>> {
  return getCatalogModeModelIds(await getEnabledByokProviders(readDb, owner));
}

/**
 * Resolves a stored model reference, such as a custom router entry, for the owner's
 * keys: a bespoke id of a catalog-mode key becomes its catalog id, or null when it has none. Any
 * other id is returned unchanged.
 */
export async function createDirectByokReferenceResolver(
  owner: ByokOwner
): Promise<(modelId: string) => Promise<string | null>> {
  const catalogModeProviderIds = new Set(
    (await getEnabledByokProviders(readDb, owner))
      .filter(isCatalogModeKey)
      .map(key => key.providerId)
  );
  return async modelId => {
    if (catalogModeProviderIds.size === 0) return modelId;
    const { provider, model } = await getDirectByokModel(modelId.toLowerCase());
    if (!provider || !model || !catalogModeProviderIds.has(provider.id)) return modelId;
    return getDirectByokCatalogModelId(model);
  };
}

async function getDirectByokModels(keys: EnabledByokProvider[]) {
  const firstPreferredId = (await getPreferredModels()).length;
  // A catalog-mode key serves only catalog ids, so its bespoke models are not listed.
  const enabledProviders = DIRECT_BYOK_PROVIDERS.filter(provider =>
    keys.some(key => key.providerId === provider.id && !isCatalogModeKey(key))
  );
  const modelsByProvider = await Promise.all(
    enabledProviders.map(async provider => ({ provider, models: await provider.models() }))
  );
  let nextPreferredId = firstPreferredId;
  return modelsByProvider.flatMap(({ provider, models }) =>
    models.map(model => convertModel(provider, model, nextPreferredId++))
  );
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
  const keys = await getEnabledByokProviders(readDb, { type: 'organization', id: organizationId });
  return keys.length === 0 ? [] : await getDirectByokModels(keys);
}

export async function getDirectByokModelsForUser(userId: string) {
  const keys = await getEnabledByokProviders(readDb, { type: 'user', id: userId });
  return keys.length === 0 ? [] : await getDirectByokModels(keys);
}

/**
 * An AI SDK provider for calling `modelId` with a stored credential, such as for
 * key tests. It applies the resolved upstream's Chat Completions URL and auth;
 * the model is resolved by id alone, so it must be one the provider serves over
 * Chat Completions.
 */
export async function createAiSdkProvider(
  directByokProvider: DirectByokProvider,
  credential: string,
  modelId: string
) {
  const upstream = await directByokProvider.resolveUpstream({
    credential,
    model: { id: modelId },
    stream: false,
  });
  if (!upstream.supportedChatApis.includes('chat_completions')) {
    throw new Error(`${directByokProvider.id} does not serve ${modelId} over Chat Completions`);
  }
  const chatCompletionsUrl = upstream.apiUrlOverrides.chat_completions ?? upstream.apiUrl;
  const { awsBedrock, apiKeyHeader, apiKey, disableUrlSuffix } = upstream;
  return createOpenAICompatible({
    baseURL: chatCompletionsUrl,
    apiKey: awsBedrock || apiKeyHeader ? undefined : apiKey,
    name: 'openaiCompatible',
    headers: {
      ...(apiKeyHeader === 'x-api-key' && { 'x-api-key': apiKey }),
      ...(directByokProvider.id === 'opencode-go' && { 'x-opencode-session': randomUUID() }),
    },
    fetch: async (url, init) => {
      const requestUrl = disableUrlSuffix ? chatCompletionsUrl : String(url);
      const headers = new Headers(init?.headers);
      headers.set('user-agent', COMPATIBLE_USER_AGENT);
      if (!awsBedrock || typeof init?.body !== 'string') {
        return fetch(requestUrl, init ? { ...init, headers } : { headers });
      }
      const signedHeaders = await signBedrockRequest({
        url: requestUrl,
        method: init.method ?? 'POST',
        headers,
        body: init.body,
        credentials: awsBedrock,
      });
      return fetch(requestUrl, { ...init, headers: signedHeaders });
    },
  });
}
