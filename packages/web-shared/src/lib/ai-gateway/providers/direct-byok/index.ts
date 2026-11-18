import {
  COMPATIBLE_USER_AGENT,
  type DirectByokAiSdkProvider,
  type DirectByokModel,
  type DirectByokProvider,
  type DirectByokUpstream,
  type StaticDirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { CustomLlmProvider, OpenRouterProvider } from '@kilocode/db/schema-types';
import type {
  GatewayChatApiKind,
  Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
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
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isByokServableCatalogModelId } from '@kilocode/web-shared/lib/ai-gateway/byok/servable-catalog-model';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getAiSdkProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { getFallbackReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { signBedrockRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/aws-bedrock-signing';
import { isByokEndpointProviderId } from '@kilocode/db/schema-types';
import { createByokEndpointDirectProvider } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint/direct-provider';

/**
 * The provider slug that organization provider allow-lists use for a direct BYOK provider: its
 * general provider list counterpart, or its own listing.
 */
export function getDirectByokPolicyProviderId(provider: DirectByokProvider): string {
  return provider.openrouter_inference_provider_id ?? provider.id;
}

/**
 * What the organization policy checks for a request a direct BYOK key serves: the provider its
 * provider allow-list names, or, for the organization's own endpoint, which the allow-list cannot
 * name, only its model policy.
 */
export type DirectByokPolicyTarget =
  | {
      kind: 'provider';
      /** See `getDirectByokPolicyProviderId`. */
      providerSlug: string;
    }
  | { kind: 'organization-endpoint' };

export function getDirectByokPolicyTarget(provider: DirectByokProvider): DirectByokPolicyTarget {
  return provider.organization_endpoint
    ? { kind: 'organization-endpoint' }
    : { kind: 'provider', providerSlug: getDirectByokPolicyProviderId(provider) };
}

/**
 * Providers for `/api/v1/providers` and the provider policy screens that the general provider list
 * lacks.
 */
export function getDirectByokProviderListings(): OpenRouterProvider[] {
  const providers: ReadonlyArray<StaticDirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return providers.flatMap(({ id, provider_listing }) => {
    if (!provider_listing) return [];
    const name = DIRECT_BYOK_PROVIDERS_META[id];
    return [{ name, displayName: name, slug: id, ...provider_listing }];
  });
}

/** The name model lists and error messages show for the provider. */
export function getDirectByokProviderName(provider: DirectByokProvider): string {
  return provider.organization_endpoint
    ? provider.organization_endpoint.name
    : DIRECT_BYOK_PROVIDERS_META[provider.id];
}

/**
 * How error messages name the caller's key for the provider, such as `Synthetic key`, or
 * `Acme endpoint` for an organization's endpoint.
 */
export function getDirectByokKeyLabel(provider: DirectByokProvider): string {
  const noun = provider.organization_endpoint ? 'endpoint' : 'key';
  return `${getDirectByokProviderName(provider)} ${noun}`;
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
): DirectByokAiSdkProvider | undefined {
  if (provider.getModelChatApi) {
    return AI_SDK_PROVIDER_FOR_CHAT_API[provider.getModelChatApi(model)];
  }
  const choice = provider.getAiSdkProvider?.(id);
  return choice ? choice.aiSdkProvider : getAiSdkProvider(id);
}

function convertModel(provider: DirectByokProvider, model: DirectByokModel) {
  const id = formatDirectByokModelId(provider, model);
  const name = getDirectByokProviderName(provider) + ': ' + model.name;
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
    hasUserByokAvailable: true,
    isFree: false,
    opencode: withLegacyVariants({
      ai_sdk_provider: getDirectByokAiSdkProvider(provider, model, id),
      reasoning_options:
        model.reasoning_options ??
        (model.flags?.includes('reasoning') ? getFallbackReasoningOptions(id) : undefined),
    }),
  };
}

/**
 * The gateway provider that sends a request for `model` to `upstream`, the upstream `directByok`
 * resolved from the stored credential, under the model's upstream id.
 */
export function createDirectByokGatewayProvider(
  directByok: DirectByokProvider,
  model: DirectByokModel,
  upstream: DirectByokUpstream
): Provider {
  return {
    type: 'direct-byok',
    ...upstream,
    inferenceProviderId: getDirectByokPolicyProviderId(directByok),
    directByokKeyLabel: getDirectByokKeyLabel(directByok),
    async transformRequest(context) {
      context.request.body.model = getDirectByokUpstreamModelId(directByok, model);
      delete context.request.body.provider;
      directByok.transformRequest(context);
    },
  };
}

/** The chat APIs `provider` serves `model` over, known without the stored credential. */
export function getDirectByokModelChatApis(
  provider: DirectByokProvider,
  model: DirectByokModel
): ReadonlyArray<GatewayChatApiKind> {
  if (!provider.getModelChatApi) return provider.supportedChatApis;
  return provider.getModelChatApis?.(model) ?? [provider.getModelChatApi(model)];
}

/** The id the upstream knows `model` of `provider` by. */
export function getDirectByokUpstreamModelId(
  provider: DirectByokProvider,
  model: DirectByokModel
): string {
  return provider.upstreamModelId?.(model) ?? model.id;
}

export function findDirectByokProvider(providerId: string): DirectByokProvider | undefined {
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return providers.find(provider => provider.id === providerId);
}

type DirectByokKey = Pick<EnabledByokProvider, 'providerId' | 'endpoint'>;

/**
 * The direct BYOK provider that serves the requests of `key`, when it is a direct BYOK key: a
 * provider of `DIRECT_BYOK_PROVIDERS`, or the organization's endpoint the key defines.
 */
export function directByokProviderForKey(key: DirectByokKey): DirectByokProvider | undefined {
  if (key.endpoint && isByokEndpointProviderId(key.providerId)) {
    return createByokEndpointDirectProvider(key.providerId, key.endpoint);
  }
  return findDirectByokProvider(key.providerId);
}

/** The organization endpoints among `keys`, in key order. */
export function getByokEndpointProviders(keys: ReadonlyArray<DirectByokKey>): DirectByokProvider[] {
  return keys.flatMap(key => (key.endpoint ? (directByokProviderForKey(key) ?? []) : []));
}

/**
 * The direct BYOK providers of `keys`: providers of `DIRECT_BYOK_PROVIDERS` in that order, then
 * the organization endpoints in key order.
 */
export function directByokProvidersForKeys(
  keys: ReadonlyArray<DirectByokKey>
): DirectByokProvider[] {
  return [
    ...DIRECT_BYOK_PROVIDERS.filter(provider => keys.some(key => key.providerId === provider.id)),
    ...getByokEndpointProviders(keys),
  ];
}

/**
 * Every provider whose model ids the owner of `keys` can request: every provider of
 * `DIRECT_BYOK_PROVIDERS`, and the owner's endpoints, whose ids only their owner can use.
 */
export function directByokProvidersVisibleTo(
  keys: ReadonlyArray<DirectByokKey>
): DirectByokProvider[] {
  return [...DIRECT_BYOK_PROVIDERS, ...getByokEndpointProviders(keys)];
}

/**
 * Catalog mode needs models.dev data to map upstream models to catalog ids. An organization's
 * endpoint names each model by the catalog id it serves in catalog mode.
 */
export function supportsCatalogMode(provider: DirectByokProvider): boolean {
  return provider.models_dev_id !== undefined || provider.organization_endpoint !== undefined;
}

export type DirectByokCatalogEntry = { catalogModelId: string; model: DirectByokModel };

/** The catalog ids a key of this provider serves in catalog mode, with the model serving each. */
export async function listDirectByokCatalogModels(
  provider: DirectByokProvider
): Promise<DirectByokCatalogEntry[]> {
  if (!supportsCatalogMode(provider)) return [];
  const entries: DirectByokCatalogEntry[] = [];
  for (const [catalogModelId, model] of getPrimaryCatalogModels(await provider.models())) {
    if (await isByokServableCatalogModelId(catalogModelId)) entries.push({ catalogModelId, model });
  }
  return entries;
}

/**
 * Catalog mode is only offered while the provider maps at least one model to a catalog id;
 * otherwise a key in catalog mode would serve nothing.
 */
export async function offersCatalogMode(provider: DirectByokProvider): Promise<boolean> {
  return (await listDirectByokCatalogModels(provider)).length > 0;
}

function isCatalogModeKey(key: EnabledByokProvider, provider: DirectByokProvider): boolean {
  return key.serveCatalogModels && supportsCatalogMode(provider);
}

/** The providers of the direct BYOK keys among `keys` that are in catalog mode, or that are not. */
function providersOfKeys(
  keys: ReadonlyArray<EnabledByokProvider>,
  { catalogMode }: { catalogMode: boolean }
): DirectByokProvider[] {
  return directByokProvidersForKeys(
    keys.filter(key => {
      const provider = directByokProviderForKey(key);
      return provider !== undefined && isCatalogModeKey(key, provider) === catalogMode;
    })
  );
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
 * The primary model of each provider that serves `catalogModelId`, in provider order. A latest
 * alias (`~vendor/family-latest`) is served by the models that serve its current target.
 */
export async function findDirectByokCatalogModels(
  catalogModelId: string,
  providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS
): Promise<DirectByokCatalogModel[]> {
  const targetModelId = await resolveOpenRouterModelAlias(catalogModelId);
  const candidates = await Promise.all(
    providers.map(async provider => {
      if (!supportsCatalogMode(provider)) return [];
      const model = getPrimaryCatalogModels(await provider.models()).get(targetModelId);
      return model ? [{ provider, model }] : [];
    })
  );
  const found = candidates.flat();
  if (found.length === 0 || !(await isByokServableCatalogModelId(catalogModelId))) return [];
  if (targetModelId !== catalogModelId && !(await isByokServableCatalogModelId(targetModelId)))
    return [];
  return found;
}

/** Serving providers per catalog id; a latest alias is served by the providers of its target. */
type CatalogModeProviders = Map<string, DirectByokProvider[]>;

async function addLatestAliasModelIds(providersByModelId: CatalogModeProviders): Promise<void> {
  if (providersByModelId.size === 0) return;
  const storedModels = await getOpenRouterModelsMetadataFromDatabase();
  for (const [modelId, storedModel] of Object.entries(storedModels)) {
    const targetModelId = storedModel.alias_target?.slug;
    const targetProviders = targetModelId ? providersByModelId.get(targetModelId) : undefined;
    if (
      modelId.startsWith('~') &&
      targetProviders &&
      (await isByokServableCatalogModelId(modelId))
    ) {
      providersByModelId.set(modelId, targetProviders);
    }
  }
}

/** Whether a catalog-mode key with policy target `target` may serve `catalogModelId`. */
export type DirectByokCatalogServingCheck = (
  catalogModelId: string,
  target: DirectByokPolicyTarget
) => Promise<boolean>;

const allowEveryCatalogProvider: DirectByokCatalogServingCheck = async () => true;

async function getCatalogModeModelIds(
  keys: EnabledByokProvider[],
  isServingAllowed: DirectByokCatalogServingCheck
): Promise<ReadonlySet<string>> {
  const providersByModelId: CatalogModeProviders = new Map();
  for (const provider of providersOfKeys(keys, { catalogMode: true })) {
    for (const { catalogModelId } of await listDirectByokCatalogModels(provider)) {
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
      if (await isServingAllowed(modelId, getDirectByokPolicyTarget(provider))) {
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
  const catalogModeProviders = providersOfKeys(await getEnabledByokProviders(readDb, owner), {
    catalogMode: true,
  });
  return async modelId => {
    if (catalogModeProviders.length === 0) return modelId;
    const { provider, model } = await getDirectByokModel(
      modelId.toLowerCase(),
      catalogModeProviders
    );
    if (!provider || !model) return modelId;
    return getDirectByokCatalogModelId(model);
  };
}

/** Models the enabled keys among `keys` serve under their bespoke ids. */
export async function getDirectByokModels(keys: ReadonlyArray<EnabledByokProvider>) {
  // A catalog-mode key serves only catalog ids, so its bespoke models are not listed.
  const enabledProviders = providersOfKeys(keys, { catalogMode: false });
  const modelsByProvider = await Promise.all(
    enabledProviders.map(async provider => ({ provider, models: await provider.models() }))
  );
  return modelsByProvider.flatMap(({ provider, models }) =>
    models.map(model => convertModel(provider, model))
  );
}

export async function getDirectByokModel(
  requestedModel: string,
  providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS
): Promise<{
  provider: DirectByokProvider | null;
  model: DirectByokModel | null;
}> {
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

/**
 * The URL string of a fetch input: a string as it arrives, a `URL` by its `href`, and a `Request`
 * by its `url`. Interpolating the input would turn a `Request` into `[object Request]`.
 */
function fetchInputUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
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
