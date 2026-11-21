import {
  COMPATIBLE_USER_AGENT,
  type DirectByokAiSdkProvider,
  type DirectByokModel,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { CustomLlmProvider, OpenRouterProvider } from '@kilocode/db/schema-types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { OpenRouterCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import { directByokProviderList } from './direct-byok-definitions';
import { formatModelId, modelIdPrefixOf } from './model-id';
import {
  getEnabledByokProviders,
  type ByokOwner,
  type EnabledByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getPrimaryCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/catalog-models';
import {
  getOpenRouterModelsMetadataFromDatabase,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isByokServableCatalogModelId } from '@kilocode/web-shared/lib/ai-gateway/byok/servable-catalog-model';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getAiSdkProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';

/**
 * The provider slug that organization provider allow-lists use for a direct BYOK provider: its
 * general provider list counterpart, or its own listing.
 */
export function getDirectByokPolicyProviderId(provider: DirectByokProvider): string {
  return provider.openrouter_inference_provider_id ?? provider.id;
}

/**
 * Providers for `/api/v1/providers` and the provider policy screens that the general provider list
 * lacks.
 */
export function getDirectByokProviderListings(): OpenRouterProvider[] {
  return directByokProviderList.flatMap(({ id, provider_listing }) => {
    if (!provider_listing) return [];
    const name = DIRECT_BYOK_PROVIDERS_META[id];
    return [{ name, displayName: name, slug: id, ...provider_listing }];
  });
}

export function formatDirectByokModelId(provider: DirectByokProvider, model: DirectByokModel) {
  return formatModelId(provider.id, model.id);
}

/**
 * A direct BYOK model as `/api/v1/models` lists it: the OpenRouter model contract, plus the fields
 * older clients read that the catalog schema does not describe.
 */
export type DirectByokModelListing = OpenRouterCatalogModel & {
  canonical_slug: string;
  hugging_face_id: string;
  architecture: { instruct_type: string | null };
  default_parameters: Record<string, never>;
  /** Every direct BYOK listing states its reasoning settings, even when the model has none. */
  opencode: NonNullable<OpenRouterCatalogModel['opencode']>;
};

const AI_SDK_PROVIDER_FOR_CHAT_API = {
  chat_completions: undefined,
  messages: 'anthropic',
  responses: 'openai',
} as const satisfies Record<GatewayChatApiKind, CustomLlmProvider | undefined>;

/**
 * Where a provider states the chat APIs it serves a model over: one API it assigns to that model,
 * or the fixed set it serves every model over.
 */
type DirectByokChatApiSource =
  | { kind: 'per-model'; chatApi: GatewayChatApiKind }
  | { kind: 'every-model'; chatApis: ReadonlyArray<GatewayChatApiKind> };

function getDirectByokChatApiSource(
  provider: DirectByokProvider,
  model: DirectByokModel
): DirectByokChatApiSource {
  return provider.getModelChatApi
    ? { kind: 'per-model', chatApi: provider.getModelChatApi(model) }
    : { kind: 'every-model', chatApis: provider.supportedChatApis };
}

function getDirectByokAiSdkProvider(
  provider: DirectByokProvider,
  model: DirectByokModel,
  id: string
): DirectByokAiSdkProvider | undefined {
  const source = getDirectByokChatApiSource(provider, model);
  if (source.kind === 'per-model') return AI_SDK_PROVIDER_FOR_CHAT_API[source.chatApi];
  const choice = provider.getAiSdkProvider?.(id);
  return choice ? choice.aiSdkProvider : getAiSdkProvider(id);
}

function convertModel(
  provider: DirectByokProvider,
  model: DirectByokModel
): DirectByokModelListing {
  const id = formatDirectByokModelId(provider, model);
  const name = DIRECT_BYOK_PROVIDERS_META[provider.id] + ': ' + model.name;
  const hasVision = model.flags?.includes('vision') ?? false;
  const hasReasoning = model.flags?.includes('reasoning') ?? false;
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name,
    created: 631148400, // our clients do not care about this field, we can fix it later if that changes
    description: model.description ?? '',
    context_length: model.context_length,
    architecture: {
      modality: hasVision ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(hasVision ? ['image'] : []),
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
      hasReasoning ? ['reasoning'] : []
    ),
    default_parameters: {},
    hasUserByokAvailable: true,
    isFree: false,
    opencode: withLegacyVariants({
      ai_sdk_provider: getDirectByokAiSdkProvider(provider, model, id),
      reasoning_options:
        model.reasoning_options ?? (hasReasoning ? getFallbackReasoningOptions(id) : undefined),
    }),
  };
}

/** The chat APIs `provider` serves `model` over, known without the stored credential. */
export function getDirectByokModelChatApis(
  provider: DirectByokProvider,
  model: DirectByokModel
): ReadonlyArray<GatewayChatApiKind> {
  const source = getDirectByokChatApiSource(provider, model);
  return source.kind === 'per-model' ? [source.chatApi] : source.chatApis;
}

export function findDirectByokProvider(providerId: string): DirectByokProvider | undefined {
  return directByokProviderList.find(provider => provider.id === providerId);
}

/** Whether the provider maps its models to models.dev catalog ids, which catalog mode needs. */
function hasCatalogData(provider: DirectByokProvider): boolean {
  return provider.models_dev_id !== undefined;
}

export function supportsCatalogMode(providerId: string): boolean {
  const provider = findDirectByokProvider(providerId);
  return provider !== undefined && hasCatalogData(provider);
}

export type DirectByokCatalogEntry = { catalogModelId: string; model: DirectByokModel };

/** The servable catalog models of a provider, each with the model that serves it. */
async function* servableCatalogModels(
  provider: DirectByokProvider
): AsyncGenerator<DirectByokCatalogEntry> {
  const models = getPrimaryCatalogModels(await provider.models());
  for (const [catalogModelId, model] of models) {
    if (await isByokServableCatalogModelId(catalogModelId)) yield { catalogModelId, model };
  }
}

/** The catalog ids a provider with catalog data serves, with the model serving each. */
async function listCatalogModelsOfProvider(
  provider: DirectByokProvider
): Promise<DirectByokCatalogEntry[]> {
  if (!hasCatalogData(provider)) return [];
  const entries: DirectByokCatalogEntry[] = [];
  for await (const entry of servableCatalogModels(provider)) entries.push(entry);
  return entries;
}

/** The catalog ids a key of this provider serves in catalog mode, with the model serving each. */
export async function listDirectByokCatalogModels(
  providerId: string
): Promise<DirectByokCatalogEntry[]> {
  const provider = findDirectByokProvider(providerId);
  return provider ? listCatalogModelsOfProvider(provider) : [];
}

/**
 * Catalog mode is only offered while the provider maps at least one model to a catalog id;
 * otherwise a key in catalog mode would serve nothing.
 */
export async function offersCatalogMode(providerId: string): Promise<boolean> {
  const provider = findDirectByokProvider(providerId);
  if (!provider || !hasCatalogData(provider)) return false;
  for await (const _ of servableCatalogModels(provider)) return true;
  return false;
}

/** The provider a key serves catalog models with, or undefined when the key is not in catalog mode. */
function catalogModeProvider(key: EnabledByokProvider): DirectByokProvider | undefined {
  if (!key.serveCatalogModels) return undefined;
  const provider = findDirectByokProvider(key.providerId);
  return provider !== undefined && hasCatalogData(provider) ? provider : undefined;
}

function isCatalogModeKey(key: EnabledByokProvider): boolean {
  return catalogModeProvider(key) !== undefined;
}

/** The catalog id that replaces `model`'s bespoke id in catalog mode, or null when unmapped. */
export async function getDirectByokCatalogModelId(model: DirectByokModel): Promise<string | null> {
  const catalogModelId = model.catalog_model_id;
  return catalogModelId && (await isByokServableCatalogModelId(catalogModelId))
    ? catalogModelId
    : null;
}

export type DirectByokCatalogModel = { provider: DirectByokProvider; model: DirectByokModel };

/**
 * The catalog id that serves `catalogModelId`: a latest alias's current target, or the id itself.
 * Null when the id, or the target its alias points at, is no longer a servable catalog id.
 */
async function resolveServedCatalogModelId(catalogModelId: string): Promise<string | null> {
  const targetModelId = await resolveOpenRouterModelAlias(catalogModelId);
  if (!(await isByokServableCatalogModelId(catalogModelId))) return null;
  if (targetModelId !== catalogModelId && !(await isByokServableCatalogModelId(targetModelId))) {
    return null;
  }
  return targetModelId;
}

/**
 * The primary model of each provider that serves `catalogModelId`, in provider order. A latest
 * alias (`~vendor/family-latest`) is served by the models that serve its current target.
 */
export async function findDirectByokCatalogModels(
  catalogModelId: string
): Promise<DirectByokCatalogModel[]> {
  const servedModelId = await resolveServedCatalogModelId(catalogModelId);
  if (servedModelId === null) return [];
  const candidates = await Promise.all(
    directByokProviderList.map(async provider => {
      if (!hasCatalogData(provider)) return [];
      const model = getPrimaryCatalogModels(await provider.models()).get(servedModelId);
      return model ? [{ provider, model }] : [];
    })
  );
  return candidates.flat();
}

/** Serving providers per catalog id. */
type CatalogModeProviders = Map<string, DirectByokProvider[]>;

async function addLatestAliasModelIds(providersByModelId: CatalogModeProviders): Promise<void> {
  if (providersByModelId.size === 0) return;
  const storedModels = await getOpenRouterModelsMetadataFromDatabase();
  for (const modelId of Object.keys(storedModels)) {
    if (!modelId.startsWith('~')) continue;
    const servedModelId = await resolveServedCatalogModelId(modelId);
    const targetProviders = servedModelId ? providersByModelId.get(servedModelId) : undefined;
    if (targetProviders) providersByModelId.set(modelId, targetProviders);
  }
}

/**
 * Whether a catalog-mode key of the provider named by `policyProviderId` (see
 * `getDirectByokPolicyProviderId`) may serve `catalogModelId`.
 */
export type DirectByokCatalogServingCheck = (
  catalogModelId: string,
  policyProviderId: string
) => Promise<boolean>;

const allowEveryCatalogProvider: DirectByokCatalogServingCheck = async () => true;

export async function getCatalogModeModelIds(
  keys: EnabledByokProvider[],
  isServingAllowed: DirectByokCatalogServingCheck
): Promise<ReadonlySet<string>> {
  const providersByModelId: CatalogModeProviders = new Map();
  for (const key of keys) {
    const provider = catalogModeProvider(key);
    if (!provider) continue;
    for (const { catalogModelId } of await listCatalogModelsOfProvider(provider)) {
      providersByModelId.set(catalogModelId, [
        ...(providersByModelId.get(catalogModelId) ?? []),
        provider,
      ]);
    }
  }
  await addLatestAliasModelIds(providersByModelId);
  const modelIds = new Set<string>();
  for (const [modelId, providers] of providersByModelId) {
    for (const provider of providers) {
      if (await isServingAllowed(modelId, getDirectByokPolicyProviderId(provider))) {
        modelIds.add(modelId);
        break;
      }
    }
  }
  return modelIds;
}

/**
 * Catalog ids the owner's catalog-mode keys serve. With `isServingAllowed`, an id counts only when
 * one of the keys serving it passes, as routing skips the others.
 */
export async function getDirectByokCatalogModelIds(
  owner: ByokOwner,
  isServingAllowed: DirectByokCatalogServingCheck = allowEveryCatalogProvider
): Promise<ReadonlySet<string>> {
  return getCatalogModeModelIds(await getEnabledByokProviders(readDb, owner), isServingAllowed);
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
    const directByok = await getDirectByokModel(modelId);
    if (!directByok || !catalogModeProviderIds.has(directByok.provider.id)) return modelId;
    return getDirectByokCatalogModelId(directByok.model);
  };
}

async function getDirectByokModels(keys: EnabledByokProvider[]): Promise<DirectByokModelListing[]> {
  // A catalog-mode key serves only catalog ids, so its bespoke models are not listed.
  const enabledProviders = directByokProviderList.filter(provider =>
    keys.some(key => key.providerId === provider.id && !isCatalogModeKey(key))
  );
  const modelsByProvider = await Promise.all(
    enabledProviders.map(async provider => ({ provider, models: await provider.models() }))
  );
  return modelsByProvider.flatMap(({ provider, models }) =>
    models.map(model => convertModel(provider, model))
  );
}

/**
 * Resolves a `<provider>/<model>` id to the provider and the model it serves, or null when either
 * is unknown. The id is matched in any casing; the canonical form is lowercase.
 */
export async function getDirectByokModel(
  requestedModel: string
): Promise<{ provider: DirectByokProvider; model: DirectByokModel } | null> {
  const canonicalModelId = requestedModel.toLowerCase();
  const provider = directByokProviderList.find(provider =>
    canonicalModelId.startsWith(modelIdPrefixOf(provider.id))
  );
  if (!provider) return null;
  const model = (await provider.models()).find(
    model => formatDirectByokModelId(provider, model) === canonicalModelId
  );
  return model ? { provider, model } : null;
}

/** Models the owner's enabled keys serve. */
export async function getDirectByokModelsForOwner(owner: ByokOwner) {
  return getDirectByokModels(await getEnabledByokProviders(readDb, owner));
}

export async function getDirectByokModelsForOrganization(organizationId: string) {
  return getDirectByokModelsForOwner({ type: 'organization', id: organizationId });
}

export async function getDirectByokModelsForUser(userId: string) {
  return getDirectByokModelsForOwner({ type: 'user', id: userId });
}

/** Interpolating the input would turn a `Request` into `[object Request]`. */
function fetchInputUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * An AI SDK provider for calling `modelId` with a stored credential, such as for
 * key tests. It applies the resolved upstream's Chat Completions URL and auth;
 * the model is resolved by id alone, so it must be one the provider serves over
 * Chat Completions.
 *
 * The upstream comes from the credential, so the Chat Completions check reads the
 * credential-resolved `supportedChatApis` rather than the per-model set
 * `getDirectByokModelChatApis` returns.
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
    headers: directByokProvider.chatCompletionsHeaders(upstream),
    fetch: async (url, init) => {
      const requestUrl = disableUrlSuffix ? chatCompletionsUrl : fetchInputUrlString(url);
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
