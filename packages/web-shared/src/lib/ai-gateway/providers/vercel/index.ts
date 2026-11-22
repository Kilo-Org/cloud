import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import type { VercelUserByokInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  AzureCredentialsSchema,
  BedrockCredentialsSchema,
  getRequestIgnoredVercelProviderIds,
  getVercelProviderIdForUserByok,
  isGatewayUserByokProviderId,
  normalizeInferenceProviderId,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
  VertexCredentialsSchema,
  VercelUserByokInferenceProviderIdSchema,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  GatewayRequest,
  OpenRouterProviderConfig,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  mapModelIdToVercel,
  mapVercelModelIdToOpenRouter,
  resolveVercelModelId,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  getCachedVercelInferenceProviderIdsForModel,
  getOpenRouterModelsMetadataFromDatabase,
  getVercelLanguageModelIdsFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getOpenRouterAliasTarget } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';

/**
 * Whether Vercel serves any of `openRouterInferenceProviders`. Tri-state because Vercel's
 * inference-provider data can be missing: `undefined` means the data is unavailable and the answer
 * is unknown, which callers treat differently from a known `false` (an `ignore` list fails closed,
 * an `only` list fails open).
 */
export function hasVercelInferenceProviderFor(
  openRouterInferenceProviders: string[],
  vercelInferenceProviders: string[] | null
): boolean | undefined {
  if (!vercelInferenceProviders) return undefined;
  return (
    getVercelInferenceProvidersExcludingIgnored(
      [],
      openRouterInferenceProviders,
      vercelInferenceProviders
    ).length > 0
  );
}

/** `providerIds` in routable form, without duplicates. */
function routableVercelProviderIds(
  providerIds: readonly string[],
  isAllowed: (providerId: string) => boolean
): string[] {
  return [
    ...new Set(
      providerIds
        .map(providerId => normalizeVercelInferenceProviderIdForRouting(providerId))
        .filter(isAllowed)
    ),
  ];
}

export function getVercelInferenceProvidersExcludingIgnored(
  ignoredProviders: string[],
  onlyProviders: string[] | undefined,
  vercelInferenceProviders: string[]
) {
  const ignored = new Set(ignoredProviders.map(openRouterToVercelInferenceProviderId));
  const only = onlyProviders
    ? new Set(onlyProviders.map(openRouterToVercelInferenceProviderId))
    : null;

  return routableVercelProviderIds(
    vercelInferenceProviders,
    providerId => !ignored.has(providerId) && (only === null || only.has(providerId))
  );
}

/**
 * The `only` list to send Vercel after dropping ignored providers. Without the model's cached
 * Vercel providers, an `only` list is filtered by the ignore list alone; with neither, the ignore
 * list cannot be applied, so it throws.
 */
function getVercelOnlyProvidersExcludingIgnored(
  ignoredProviders: string[],
  onlyProviders: string[] | undefined,
  vercelInferenceProviders: string[] | null
): string[] {
  if (vercelInferenceProviders) {
    return getVercelInferenceProvidersExcludingIgnored(
      ignoredProviders,
      onlyProviders,
      vercelInferenceProviders
    );
  }
  if (!onlyProviders) {
    throw new Error('Vercel inference provider data is unavailable to apply provider.ignore');
  }
  const ignored = new Set(ignoredProviders.map(openRouterToVercelInferenceProviderId));
  return routableVercelProviderIds(
    onlyProviders.map(openRouterToVercelInferenceProviderId),
    providerId => !ignored.has(providerId)
  );
}

/**
 * The `only` list to send Vercel for the request's provider settings: the requested providers in
 * Vercel's ids, filtered through `provider.ignore` when it is set. Without the model's cached Vercel
 * providers, an `ignore` list that also names an `only` list is applied to that list alone, and an
 * `ignore` list without one throws (see `getVercelOnlyProvidersExcludingIgnored`).
 */
function effectiveVercelOnlyProviders(
  provider: Pick<OpenRouterProviderConfig, 'only' | 'ignore'> | undefined,
  vercelInferenceProviders: string[] | null
): string[] | undefined {
  if (!provider?.ignore?.length) {
    return provider?.only?.map(openRouterToVercelInferenceProviderId);
  }
  return getVercelOnlyProvidersExcludingIgnored(
    provider.ignore,
    provider.only,
    vercelInferenceProviders
  );
}

/** The `GetProviderInput` fields that decide whether Kilo's own route uses the Vercel AI Gateway. */
export type VercelRoutingInput = {
  requestedModel: string;
  boundedSpending: boolean;
  /**
   * The organization disabled OpenRouter, directly or through an inference region. Kilo's
   * Vercel opt-out list then does not apply, so a model Vercel serves goes there instead of
   * failing on the disabled OpenRouter.
   */
  openRouterDisabled?: boolean;
};

export async function shouldRouteToVercel(
  { requestedModel, boundedSpending, openRouterDisabled = false }: VercelRoutingInput,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
) {
  if (boundedSpending) {
    console.debug(
      `[shouldRouteToVercel] not routing model ${requestedModel} to Vercel because a spend ceiling is set`
    );
    return false;
  }

  if (!openRouterDisabled && !(await isVercelRoutingEnabledForModel(requestedModel))) {
    // The model is opted out, so both halves of the decision need the config. Read it once, so
    // neither half can observe a different snapshot than the other.
    const provider = await getRoutingProviderConfig();
    if (!(await allowsOnlyVercelProviders(requestedModel, provider))) {
      return false;
    }
    return await canRouteToVercel(requestedModel, provider);
  }

  return await canRouteToVercel(requestedModel, await getRoutingProviderConfig());
}

/**
 * Whether the provider routing settings leave the model no OpenRouter provider but at least one
 * Vercel provider. OpenRouter cannot serve such a request, so Kilo's Vercel opt-out list does not
 * apply to it. Missing provider data on either gateway, including an unresolvable latest alias,
 * keeps the opt-out.
 */
async function allowsOnlyVercelProviders(
  requestedModel: string,
  provider: OpenRouterProviderConfig | undefined
): Promise<boolean> {
  if (!provider || (!provider.only && !provider.ignore?.length)) return false;
  const { only, ignore = [] } = provider;
  const [openRouterModels, vercelModelId] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    mapModelIdToVercel(requestedModel),
  ]);
  // OpenRouter serves a latest alias's target, including Kilo's pin, not the alias row, whose
  // endpoints can be empty.
  const openRouterModelId = requestedModel.startsWith('~')
    ? getOpenRouterAliasTarget(openRouterModels, requestedModel)
    : requestedModel;
  const openRouterModel =
    openRouterModelId !== undefined && Object.hasOwn(openRouterModels, openRouterModelId)
      ? openRouterModels[openRouterModelId]
      : undefined;
  if (!openRouterModel) return false;

  const onlyProviders = only && new Set(only.map(normalizeInferenceProviderId));
  const ignoredProviders = new Set(ignore.map(normalizeInferenceProviderId));
  const openRouterServesAllowedProvider = openRouterModel.endpoints.some(({ tag }) => {
    // An endpoint without a tag could belong to any provider.
    if (!tag) return true;
    const providerId = normalizeInferenceProviderId(tag);
    return !ignoredProviders.has(providerId) && (!onlyProviders || onlyProviders.has(providerId));
  });
  if (openRouterServesAllowedProvider) return false;

  const vercelInferenceProviders = await getCachedVercelInferenceProviderIdsForModel(vercelModelId);
  if (
    !vercelInferenceProviders ||
    getVercelInferenceProvidersExcludingIgnored(ignore, only, vercelInferenceProviders).length === 0
  ) {
    return false;
  }

  console.debug(
    `[shouldRouteToVercel] routing opted-out model ${requestedModel} to Vercel because only Vercel serves the allowed providers`
  );
  return true;
}

/** Whether Kilo's routing config sends the model to Vercel: the model is not opted out. Vercel must still serve the model. */
export async function isVercelRoutingEnabledForModel(requestedModel: string) {
  const routingConfig = await getRuntimeGatewayRoutingConfig();
  if (routingConfig.vercelOptOutModels.has(requestedModel)) {
    console.debug(`[shouldRouteToVercel] model ${requestedModel} opted out of Vercel routing`);
    return false;
  }

  return true;
}

/**
 * The single derivation of whether Vercel serves `requestedModel`: the Vercel language model ids,
 * the model's Vercel id and the admin overrides that mapped it, read together so the three
 * predicates cannot disagree about the same request.
 */
async function resolveVercelModel(requestedModel: string): Promise<{
  vercelModels: ReadonlySet<string>;
  vercelModelId: string;
  overrides: VercelModelIdOverrides;
}> {
  const [vercelModels, { vercelModelId, overrides }] = await Promise.all([
    getVercelLanguageModelIdsFromDatabase(),
    resolveVercelModelId(requestedModel),
  ]);
  return { vercelModels, vercelModelId, overrides };
}

/** Whether Vercel serves the model, regardless of the request's routing settings. */
export async function isVercelModel(requestedModel: string) {
  const { vercelModels, vercelModelId } = await resolveVercelModel(requestedModel);
  return vercelModels.has(vercelModelId);
}

/**
 * Whether a request to Vercel may name the model. Vercel must serve the model, and the request must
 * name it by a Kilo model ID: an OpenRouter ID, a retained legacy alias, or the OpenRouter-style ID
 * a Vercel-only model is listed under. Vercel's own spelling, such as `zai/glm-5` for `z-ai/glm-5`,
 * is rejected. Like `isValidOpenRouterModelId`, it assumes the model is valid while Vercel's model
 * list is unavailable, so requests through a user's own Vercel key keep working during a metadata
 * outage.
 */
export async function isValidVercelModelId(requestedModel: string) {
  const { vercelModels, vercelModelId, overrides } = await resolveVercelModel(requestedModel);
  if (vercelModels.size === 0) return true;
  if (!vercelModels.has(vercelModelId)) return false;

  return (
    mapVercelModelIdToOpenRouter(vercelModelId, overrides) === requestedModel ||
    (await isValidOpenRouterModelId(requestedModel))
  );
}

/**
 * Whether Vercel serves the model and can honor the provider routing settings.
 * Returns false when provider ignore lists cannot be checked because Vercel's
 * inference provider data is unavailable. `ignore` lists fail closed in that case,
 * while `only` lists fail open: the requested providers are still forwarded to
 * Vercel as `only`.
 */
export async function canRouteToVercel(
  requestedModel: string,
  provider: OpenRouterProviderConfig | undefined
) {
  const { vercelModels, vercelModelId } = await resolveVercelModel(requestedModel);
  if (!vercelModels.has(vercelModelId)) {
    console.debug(`[shouldRouteToVercel] model not found in Vercel model list`);
    return false;
  }

  if (provider && (provider.only || provider.ignore?.length)) {
    const { only, ignore } = provider;
    const vercelInferenceProviders =
      await getCachedVercelInferenceProviderIdsForModel(vercelModelId);

    if (ignore?.length) {
      if (!vercelInferenceProviders) {
        console.debug(
          '[shouldRouteToVercel] not routing to Vercel because inference provider data is unavailable'
        );
        return false;
      }

      const effectiveOnly = getVercelInferenceProvidersExcludingIgnored(
        ignore,
        only,
        vercelInferenceProviders
      );
      if (effectiveOnly.length === 0) {
        console.debug(
          '[shouldRouteToVercel] no inference providers remain after applying provider preferences'
        );
        return false;
      }
    } else if (only && hasVercelInferenceProviderFor(only, vercelInferenceProviders) === false) {
      console.debug(
        '[shouldRouteToVercel] none of the requested inference providers are available on Vercel'
      );
      return false;
    }
  }

  return true;
}

function getConversationId(request: GatewayRequest): string | undefined {
  const id = request.kind === 'messages' ? request.body.session_id : request.body.prompt_cache_key;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// An explicit session ID makes Vercel pin the exact credential that served the
// session, keeping its prompt cache warm after a fallback.
// https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity
function getSessionAffinityOptions(
  request: GatewayRequest
): Pick<NonNullable<VercelProviderConfig['gateway']>, 'sessionId' | 'sessionAffinity'> {
  const sessionId = getConversationId(request);
  return sessionId ? { sessionId, sessionAffinity: true } : { sessionAffinity: true };
}

function convertProviderSort(
  sort: OpenRouterProviderConfig['sort']
): GatewayProviderOptions['sort'] {
  switch (sort) {
    case 'price':
      return 'cost';
    case 'throughput':
      return 'tps';
    case 'latency':
      return 'ttft';
    default:
      return undefined;
  }
}

function getDataHandlingOptions(
  provider: Pick<OpenRouterProviderConfig, 'zdr' | 'data_collection'> | undefined
) {
  return {
    zeroDataRetention: provider?.zdr,
    disallowPromptTraining: provider?.data_collection === 'deny' || undefined,
  };
}

/**
 * The zone-scoped inference region both Vercel paths send. Vercel fails the request instead of
 * leaving the region once one is asked for.
 * https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference
 */
function inferenceRegionOptions(dataRegion: OrganizationDataRegion) {
  return { scope: 'zone', geoRegion: dataRegion } as const;
}

/**
 * The BYOK credentials to send Vercel, by Vercel provider id. `provider.ignore` is a routing
 * preference, not an authorization boundary, so it never removes the last credential: an empty map
 * would send `only: []` with `byok: {}`, dropping BYOK pinning so inference bills Kilo's Vercel
 * account while the request still counts as BYOK downstream and skips the zero-balance rejection in
 * the gateway route.
 */
function getByokProvidersExcludingIgnored(
  userByok: readonly BYOKResult[],
  ignoredProviders: ReadonlySet<string>
): Record<string, VercelInferenceProviderConfig[]> {
  const allByokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
  const retainedByokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
  for (const byokEntry of userByok) {
    const [key, list] = getVercelInferenceProviderConfigForUserByok(byokEntry);
    allByokProviders[key] = [...(allByokProviders[key] ?? []), ...list];
    if (!ignoredProviders.has(key)) {
      retainedByokProviders[key] = [...(retainedByokProviders[key] ?? []), ...list];
    }
  }
  return Object.keys(retainedByokProviders).length > 0 ? retainedByokProviders : allByokProviders;
}

/**
 * The BYOK half of a Vercel gateway config. `only` and `byok` are produced from one call so they
 * always name the same providers: a request that dropped a key from `byok` but kept its provider in
 * `only`, or the reverse, would lose the BYOK pinning this pair exists to keep.
 */
function byokGatewayOptions(
  userByok: readonly BYOKResult[],
  ignoredProviders: ReadonlySet<string>
): { only: string[]; byok: Record<string, VercelInferenceProviderConfig[]> } {
  const byok = getByokProvidersExcludingIgnored(userByok, ignoredProviders);
  return { only: Object.keys(byok), byok };
}

/**
 * The request-level fields both routing paths forward: the caller's sort
 * preference, data-handling choices and session affinity.
 *
 * Caller fallback models are not among them: `removeModelsFallback` deletes
 * `body.models` and `body.fallbacks` before any Vercel setting is built, so a
 * fallback id never reaches this gateway in either spelling.
 */
function getSharedGatewayOptions(
  request: GatewayRequest
): Pick<
  NonNullable<VercelProviderConfig['gateway']>,
  'sort' | 'zeroDataRetention' | 'disallowPromptTraining' | 'sessionId' | 'sessionAffinity'
> {
  const provider = request.body.provider;
  return {
    sort: convertProviderSort(provider?.sort),
    ...getDataHandlingOptions(provider),
    ...getSessionAffinityOptions(request),
  };
}

export function convertProviderOptions(
  requestToMutate: GatewayRequest,
  vercelInferenceProviders: string[] | null
): VercelProviderConfig {
  const provider = requestToMutate.body.provider;
  const only = effectiveVercelOnlyProviders(provider, vercelInferenceProviders);

  const serviceTier = requestToMutate.body.service_tier;
  return {
    gateway: {
      only,
      order: provider?.order?.map(openRouterToVercelInferenceProviderId),
      serviceTier: serviceTier === 'flex' || serviceTier === 'priority' ? serviceTier : undefined,
      ...getSharedGatewayOptions(requestToMutate),
    },
  };
}

/**
 * The Vercel gateway options of a non-chat request, such as embeddings or System One. Provider keys
 * sent through Kilo's Vercel account travel as `byok`, restricted to their providers, as on chat;
 * the request's `provider.ignore` drops a key unless it would drop them all. Kilo's own route and
 * the owner's Vercel AI Gateway key carry the effective provider routing settings instead (`only`,
 * `ignore` and `order`, in Vercel's provider ids), and only Kilo's route a region (see
 * `getRouteInferenceRegion`); Vercel fails the request instead of leaving the region. Both carry
 * the data-handling choices.
 *
 * Vercel treats an empty `only` as no filter, so when the routing settings leave no provider that
 * serves the model, the result names the model's providers instead and the caller rejects the
 * request, as `canRouteToVercel` keeps chat off Vercel.
 */
export async function getNonChatGatewayOptions(params: {
  /** The model id the request sends to Vercel, after `mapModelIdToVercel`. */
  vercelModelId: string;
  userByok: readonly BYOKResult[] | null;
  provider:
    | Pick<OpenRouterProviderConfig, 'only' | 'ignore' | 'order' | 'zdr' | 'data_collection'>
    | undefined;
  dataRegion: OrganizationDataRegion | null;
}): Promise<
  | { kind: 'routable'; gateway: NonNullable<VercelProviderConfig['gateway']> }
  /** `providers` holds the model's Vercel providers, when known. */
  | { kind: 'no-eligible-provider'; providers: string[] }
> {
  const { vercelModelId, userByok, provider, dataRegion } = params;
  const dataHandling = getDataHandlingOptions(provider);
  const providerKeys = userByok?.filter(byok => !isGatewayUserByokProviderId(byok.providerId));
  if (providerKeys && providerKeys.length > 0) {
    return {
      kind: 'routable',
      gateway: {
        ...byokGatewayOptions(providerKeys, getRequestIgnoredVercelProviderIds(provider)),
        ...dataHandling,
      },
    };
  }
  const vercelInferenceProviders =
    provider?.only || provider?.ignore?.length
      ? await getCachedVercelInferenceProviderIdsForModel(vercelModelId)
      : null;
  // The chat path was already vetted by `canRouteToVercel`, so it sends a mapped `only` list even
  // when none of those providers is compatible. This path has no such check, so it rejects instead.
  const only =
    provider?.only &&
    !provider.ignore?.length &&
    hasVercelInferenceProviderFor(provider.only, vercelInferenceProviders) === false
      ? []
      : effectiveVercelOnlyProviders(provider, vercelInferenceProviders);
  if (only?.length === 0) {
    return {
      kind: 'no-eligible-provider',
      providers: vercelInferenceProviders
        ? routableVercelProviderIds(vercelInferenceProviders, () => true)
        : [],
    };
  }
  return {
    kind: 'routable',
    gateway: {
      only,
      order: provider?.order?.map(openRouterToVercelInferenceProviderId),
      ...dataHandling,
      ...(dataRegion && { inferenceRegion: inferenceRegionOptions(dataRegion) }),
    },
  };
}

function parseCredentials<T>(
  input: string,
  schema: { parse(input: unknown): T },
  providerName: string
): T {
  try {
    return schema.parse(JSON.parse(input));
  } catch {
    throw new Error(`Failed to parse ${providerName} credentials`);
  }
}

export function getAnthropicProviderOptionsForVercel(
  request: GatewayRequest
): AnthropicProviderOptions | undefined {
  const anthropicOptions: AnthropicProviderOptions = {};

  if (request.kind === 'chat_completions' && request.body.verbosity) {
    anthropicOptions.effort = request.body.verbosity;
  }
  if (request.kind === 'responses' && request.body.text?.verbosity) {
    anthropicOptions.effort = request.body.text.verbosity;
  }

  if (Object.keys(anthropicOptions).length === 0) {
    return undefined;
  }

  return anthropicOptions;
}

export function getVercelInferenceProviderConfigForUserByok(
  provider: BYOKResult
): [VercelUserByokInferenceProviderId, VercelInferenceProviderConfig[]] {
  const key = VercelUserByokInferenceProviderIdSchema.parse(
    getVercelProviderIdForUserByok(provider.providerId)
  );

  const list = new Array<VercelInferenceProviderConfig>();

  if (key === VercelUserByokInferenceProviderIdSchema.enum.zai) {
    // A zai key sends two credentials, in this order: the Z.ai Coding Plan endpoint first, then the
    // plain credential. The plain entry stays so the same key also works against the standard Z.ai
    // endpoint. The Coding Plan entry exists for older keys, because requiring them to move to the
    // explicit Z.ai Coding Plan option would be a breaking change.
    list.push({
      apiKey: provider.decryptedAPIKey,
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
    });
    list.push({ apiKey: provider.decryptedAPIKey });
    return [key, list];
  }

  if (key === VercelUserByokInferenceProviderIdSchema.enum.azure) {
    list.push(parseCredentials(provider.decryptedAPIKey, AzureCredentialsSchema, 'Azure'));
  } else if (key === VercelUserByokInferenceProviderIdSchema.enum.bedrock) {
    list.push(parseCredentials(provider.decryptedAPIKey, BedrockCredentialsSchema, 'AWS'));
  } else if (key === VercelUserByokInferenceProviderIdSchema.enum.vertex) {
    list.push(parseCredentials(provider.decryptedAPIKey, VertexCredentialsSchema, 'Google Vertex'));
  } else {
    list.push({ apiKey: provider.decryptedAPIKey });
  }
  return [key, list];
}

export async function applyVercelSettings(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userByok: BYOKResult[] | null,
  dataRegion: OrganizationDataRegion | null
) {
  const vercelModelId = await mapModelIdToVercel(requestedModel);
  requestToMutate.body.model = vercelModelId;

  if (userByok) {
    if (userByok.length === 0) {
      throw new Error('Invalid state: userByok should be null or not empty');
    }
    // Only honor the caller's own `provider.ignore` here. `getProvider` has
    // already dropped keys outside the organization provider allow-list (see
    // `isVercelUserByokProviderAllowed`). Filtering by `provider.only` again
    // would also drop keys whose provider has no OpenRouter slug, which the
    // allow-list cannot name.
    const byokGateway = byokGatewayOptions(
      userByok,
      getRequestIgnoredVercelProviderIds(requestToMutate.body.provider)
    );

    // Pass request-scoped credentials and restrict routing to the corresponding providers.
    // Unlike Vercel's documented behavior, Vercel special-cases Kilo to never fall back to
    // system credentials when BYOK credentials fail, so BYOK requests are never billed to Kilo.
    // https://anaconda.slack.com/archives/C0BQLEKUCV9/p1792652138592319
    // Request-level data handling preferences travel with the request on every routing path,
    // so upstream providers receive the caller's retention and training choices consistently.
    // `order` and `serviceTier` apply to the managed path only.
    requestToMutate.body.providerOptions = {
      gateway: { ...byokGateway, ...getSharedGatewayOptions(requestToMutate) },
    };
  } else {
    const vercelInferenceProviders =
      await getCachedVercelInferenceProviderIdsForModel(vercelModelId);
    requestToMutate.body.providerOptions = convertProviderOptions(
      requestToMutate,
      vercelInferenceProviders
    );
  }

  // The caller passes a region only for a route Kilo pays for (see `getRouteInferenceRegion`).
  if (dataRegion && requestToMutate.body.providerOptions?.gateway) {
    requestToMutate.body.providerOptions.gateway.inferenceRegion =
      inferenceRegionOptions(dataRegion);
  }

  if (requestToMutate.body.providerOptions) {
    const anthropicOptions = getAnthropicProviderOptionsForVercel(requestToMutate);
    if (anthropicOptions) {
      requestToMutate.body.providerOptions.anthropic = anthropicOptions;
    }
  }

  delete requestToMutate.body.provider;
}
