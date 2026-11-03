import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  DirectUserByokInferenceProviderIdSchema,
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  openRouterToVercelInferenceProviderId,
  isGatewayUserByokProviderId,
  isVercelUserByokProviderAllowed,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { withIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import {
  byokOwner,
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getByokKeyStates,
  getCatalogModeByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  isGatewayUserByokEligibleModel,
  type ByokKeyState,
  type ByokOwner,
  type ByokSourceDb,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  createByokRouteRank,
  getByokKeyDefaultRank,
} from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import {
  createRoutingDecisionRecorder,
  type ByokCandidateSkipReason,
  type ProviderRoutingDecision,
  type RoutingDecisionRecorder,
  type RoutingDecisionStep,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  GatewayChatApiKindSchema,
  type BYOKResult,
  type GatewayChatApiKind,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  createUserOpenRouterProvider,
  OPENROUTER,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import {
  createUserVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  findDirectByokCatalogModels,
  getDirectByokCatalogModelId,
  getDirectByokModel,
  getDirectByokModelChatApis,
  getDirectByokPolicyProviderId,
  supportsCatalogMode,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  checkOpenAiChatGptByok,
  getOpenAiChatGptCandidateModel,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import * as z from 'zod';
import { CustomLlmCredentialsSchema, type CustomLlmCredentials } from '@kilocode/db/schema-types';
import {
  findCustomLlm,
  isPublicCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { getCustomLlmApiKinds } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/api-kinds';
import {
  buildDirectProvider,
  type DirectUpstreamAuth,
} from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import { userHasCustomLlmAccess } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/access';
import { isCustomLlmDeniedInCountry } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { removePaidServerFeatures } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-paid-server-features';
import {
  getLocalFakeLlmProvider,
  getLocalFakeTranscriptionProvider,
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';

export type GetProviderProviderResult = {
  kind: 'provider';
  provider: Provider;
  userByok: BYOKResult[] | null;
  readonly isFree: boolean;
  /** Skip paid-auth and organization policy checks. Used by bespoke direct-byok
   *  ids and non-public custom_llm2 because both already require explicit admin
   *  opt-in. A request that is neither free nor user funded still needs a
   *  balance. */
  bypassAccessCheck: boolean;
  /** Skip only the zero-balance paid-model block. Set when a user credential
   *  outside Kilo credits pays for the request, such as the ChatGPT
   *  subscription, while abuse and organization policy checks still apply. */
  skipBalanceCheck?: boolean;
};

/** A bespoke direct BYOK id whose key serves only catalog ids. */
export type DirectByokCatalogOnlyResult = {
  kind: 'direct-byok-catalog-only';
  providerId: DirectByokProvider['id'];
  /** The catalog id that serves the same model through the key, when one exists. */
  catalogModelId: string | null;
};

export type GetProviderResult =
  | GetProviderProviderResult
  | { kind: 'chatgpt-reconnect'; message: string }
  /** The id is a custom LLM the caller may not use, or its stored credentials are unusable. */
  | { kind: 'custom-llm-unavailable' }
  | DirectByokCatalogOnlyResult;

async function directByokProviderResult(
  directByok: DirectByokProvider,
  directByokModel: DirectByokModel,
  credential: BYOKResult,
  requestedModel: string,
  request: GatewayRequest,
  servesCatalogId: boolean
): Promise<GetProviderProviderResult> {
  const upstream = await directByok.resolveUpstream({
    credential: credential.decryptedAPIKey,
    model: directByokModel,
    stream: request.body.stream === true,
  });

  return {
    kind: 'provider',
    provider: {
      type: 'direct-byok',
      ...upstream,
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        delete context.request.body.provider;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok: [{ decryptedAPIKey: credential.decryptedAPIKey, providerId: credential.providerId }],
    isFree: await isFreeModel(requestedModel),
    // Organization model and provider policies cover catalog ids. A bespoke id is only served by a
    // key outside catalog mode, which stays exempt as before.
    bypassAccessCheck: !servesCatalogId,
  };
}

/**
 * A catalog id: metadata of the caller's enabled catalog-mode keys for it, ranked with their other
 * keys by the caller. Only the key that takes the request is decrypted.
 */
type DirectByokCatalogCandidates = {
  kind: 'direct-byok-catalog-candidates';
  candidates: DirectByokCatalogCandidate<ByokKeyState>[];
};

/**
 * Direct BYOK model IDs name their provider, such as `neuralwatt/...`, and the
 * request goes straight to that provider with the stored key, bypassing Kilo's
 * gateways. A key in catalog mode instead serves the catalog ids its provider maps.
 */
async function resolveDirectByokProvider(
  user: User | AnonymousUserContext,
  requestedModel: string,
  request: GatewayRequest,
  organizationId: string | undefined,
  isDirectByokProviderAllowed: (policyProviderId: string) => Promise<boolean>,
  loadKeyStates: () => Promise<ByokKeyState[]>,
  decision: RoutingDecisionRecorder
): Promise<
  GetProviderProviderResult | DirectByokCatalogOnlyResult | DirectByokCatalogCandidates | null
> {
  const owner = byokOwner(user.id, organizationId);
  const { provider: directByok, model: directByokModel } = await getDirectByokModel(requestedModel);
  if (directByok && directByokModel) {
    const providerId = directByok.id;
    const [credential] = await getByokCredentials(readDb, owner, [providerId]);
    if (!credential) {
      decision.step({
        step: 'direct-byok-model',
        outcome: 'skipped',
        provider_id: providerId,
        reason: 'no-key',
      });
      return null;
    }
    if (credential.serveCatalogModels && supportsCatalogMode(providerId)) {
      const catalogModelId = await getDirectByokCatalogModelId(directByokModel);
      decision.step({
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: providerId,
        reason: 'catalog-only',
        catalog_model_id: catalogModelId,
      });
      return { kind: 'direct-byok-catalog-only', providerId, catalogModelId };
    }
    decision.step({ step: 'direct-byok-model', outcome: 'selected', provider_id: providerId });
    return directByokProviderResult(
      directByok,
      directByokModel,
      credential,
      requestedModel,
      request,
      false
    );
  }

  decision.step({ step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' });
  if (isAnonymousContext(user)) return null;
  // Keys for providers the organization policy does not admit are never loaded, so a later route
  // that honors the policy takes the request, and an undecryptable allowed key still fails closed.
  const catalogModels: DirectByokCatalogModel[] = [];
  const excludedProviderIds: string[] = [];
  for (const catalogModel of await findDirectByokCatalogModels(requestedModel)) {
    if (await isDirectByokProviderAllowed(getDirectByokPolicyProviderId(catalogModel.provider))) {
      catalogModels.push(catalogModel);
    } else {
      excludedProviderIds.push(catalogModel.provider.id);
    }
  }
  if (excludedProviderIds.length > 0) {
    decision.step({ step: 'organization-policy', excluded_provider_ids: excludedProviderIds });
  }
  if (catalogModels.length === 0) return null;
  const catalogModeKeys = (await loadKeyStates()).filter(
    key => key.isEnabled && key.serveCatalogModels
  );
  return {
    kind: 'direct-byok-catalog-candidates',
    candidates: rankDirectByokCatalogKeys(catalogModels, catalogModeKeys, request.kind),
  };
}

type DirectByokCatalogKeyDecision =
  | 'serves'
  | 'unsupported-api-kind'
  | 'disabled'
  | 'not-catalog-mode';

type DirectByokCatalogCandidate<K> = DirectByokCatalogModel & {
  key: K;
  decision: DirectByokCatalogKeyDecision;
};

/**
 * The owner's keys for the providers that serve a catalog id, in `DIRECT_BYOK_PROVIDERS` order,
 * with whether each can take the request. Routing passes decrypted credentials and the preview
 * passes key metadata, so the decision never needs a key.
 */
function rankDirectByokCatalogKeys<K extends ByokKeyState>(
  catalogModels: readonly DirectByokCatalogModel[],
  keys: readonly K[],
  apiKind: GatewayChatApiKind
): DirectByokCatalogCandidate<K>[] {
  return catalogModels.flatMap(({ provider, model }) => {
    const key = keys.find(candidate => candidate.providerId === provider.id);
    if (!key) return [];
    const decision: DirectByokCatalogKeyDecision = !key.isEnabled
      ? 'disabled'
      : !key.serveCatalogModels
        ? 'not-catalog-mode'
        : getDirectByokModelChatApis(provider, model).includes(apiKind)
          ? 'serves'
          : 'unsupported-api-kind';
    return [{ provider, model, key, decision }];
  });
}

async function isEligibleForCustomLlm(
  customLlm: CustomLlm,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
) {
  // An anonymous caller has no balance to bill.
  if (isAnonymousContext(user))
    return isPublicCustomLlm(customLlm.definition) && !customLlm.definition.pricing;
  if (isPublicCustomLlm(customLlm.definition)) return true;
  if (!organizationId) return false;
  return await userHasCustomLlmAccess(customLlm.definition, organizationId, user.id);
}

function readCustomLlmCredentials(customLlm: CustomLlm): CustomLlmCredentials | null {
  if (!customLlm.encrypted_api_key) return null;
  const decrypted = decryptApiKey(customLlm.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return null;
  }
  return CustomLlmCredentialsSchema.safeParse(parsedJson).data ?? null;
}

async function resolveCustomLlmAuth(
  credentials: CustomLlmCredentials
): Promise<DirectUpstreamAuth> {
  switch (credentials.type) {
    case 'api_key':
      return { type: 'api_key', apiKey: credentials.api_key, apiKeyHeader: null };
    case 'x-api-key':
      return { type: 'api_key', apiKey: credentials.api_key, apiKeyHeader: 'x-api-key' };
    case 'service_account':
      return {
        type: 'api_key',
        apiKey: await getGoogleServiceAccountAccessToken(credentials),
        apiKeyHeader: null,
      };
    case 'secure_proxy':
      return { type: 'secure_proxy', credentials };
    case 'aws_bedrock':
      return { type: 'aws_bedrock', credentials };
  }
}

/**
 * A custom LLM owns its id: a caller without access, including one from a
 * denied country, or a definition with unusable credentials, must not fall back
 * to another upstream for the same id.
 */
async function resolveCustomLlmProvider(
  customLlm: CustomLlm,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  countryCode: string | null,
  decision: RoutingDecisionRecorder
): Promise<GetProviderResult> {
  const { definition } = customLlm;
  const isPublic = isPublicCustomLlm(definition);
  const visibility = isPublic ? 'public' : 'private';
  const reject = (
    reason: 'country-denied' | 'not-eligible' | 'invalid-credentials'
  ): GetProviderResult => {
    decision.step({ step: 'custom-llm', outcome: 'rejected', visibility, reason });
    return { kind: 'custom-llm-unavailable' };
  };
  if (isCustomLlmDeniedInCountry(definition, countryCode)) return reject('country-denied');
  if (!(await isEligibleForCustomLlm(customLlm, user, organizationId))) {
    return reject('not-eligible');
  }
  const credentials = readCustomLlmCredentials(customLlm);
  if (!credentials) {
    console.error('Custom LLM credentials are missing or invalid', customLlm.public_id);
    return reject('invalid-credentials');
  }

  decision.step({ step: 'custom-llm', outcome: 'selected', visibility });
  const provider = buildDirectProvider(
    isPublic ? 'custom-public' : 'custom',
    getCustomLlmApiKinds(definition),
    definition,
    await resolveCustomLlmAuth(credentials)
  );
  return {
    kind: 'provider',
    provider: isPublic ? withoutPaidServerFeatures(provider) : provider,
    userByok: null,
    isFree: definition.pricing === undefined,
    bypassAccessCheck: !isPublic,
  };
}

/**
 * A public custom LLM serves anyone on Kilo's credential, so like free models it
 * drops paid server features before the definition's own `extra_body` applies,
 * even when it sets pricing. Private custom LLMs keep them.
 */
function withoutPaidServerFeatures(provider: Provider): Provider {
  return {
    ...provider,
    async transformRequest(context) {
      removePaidServerFeatures(provider, context.model, context.request, context.kilo_user_id);
      await provider.transformRequest(context);
    },
  };
}

type ByokKeyRef = { providerId: UserByokProviderId; priority?: number };

/**
 * The providers whose stored key could serve a catalog model through a gateway, unlike direct
 * BYOK, where the model ID itself names the provider.
 */
async function getGatewayRoutedByokCandidateProviders(
  requestedModel: string,
  { includeGatewayKeys }: { includeGatewayKeys: boolean }
): Promise<UserByokProviderId[]> {
  // Kilo pays for the auto small free model, so no user key may serve it.
  if (isAutoSmallFreeModel(requestedModel)) return [];
  return [
    ...(await getModelInferenceUserByokProviders(requestedModel)),
    ...(includeGatewayKeys && (await isGatewayUserByokEligibleModel(requestedModel))
      ? GatewayUserByokProviderIdSchema.options
      : []),
  ];
}

type GatewayRoutedByokOptions = {
  includeGatewayKeys: boolean;
  getAllowedProviders: () => Promise<ReadonlySet<string> | undefined>;
  onExcludedByPolicy?: (providerIds: UserByokProviderId[]) => void;
};

/**
 * The providers whose keys may serve the model through a gateway. Keys for providers outside the
 * organization allow-list are never loaded, so a later route that honors the allow-list takes the
 * request, and an undecryptable allowed key still fails closed.
 */
async function getAllowedGatewayRoutedByokProviders(
  requestedModel: string,
  options: GatewayRoutedByokOptions
): Promise<UserByokProviderId[]> {
  const allProviders = await getGatewayRoutedByokCandidateProviders(requestedModel, options);
  if (allProviders.length === 0) return [];
  const allowedProviders = await options.getAllowedProviders();
  const allowed = allProviders.filter(providerId =>
    isVercelUserByokProviderAllowed(providerId, allowedProviders)
  );
  const excluded = allProviders.filter(providerId => !allowed.includes(providerId));
  if (excluded.length > 0) options.onExcludedByPolicy?.(excluded);
  return allowed;
}

async function decryptGatewayRoutedByokKeys(
  userId: string,
  organizationId: string | undefined,
  providerIds: UserByokProviderId[]
): Promise<BYOKResult[]> {
  return (
    (organizationId
      ? await getBYOKforOrganization(readDb, organizationId, providerIds)
      : await getBYOKforUser(readDb, userId, providerIds)) ?? []
  );
}

/** The enabled provider keys sent through Vercel and whole-gateway keys that may serve the model. */
async function getGatewayRoutedByokKeys(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined,
  options: GatewayRoutedByokOptions
): Promise<BYOKResult[]> {
  if (isAnonymousContext(user)) return [];
  const candidateProviders = await getAllowedGatewayRoutedByokProviders(requestedModel, options);
  if (candidateProviders.length === 0) return [];
  return decryptGatewayRoutedByokKeys(user.id, organizationId, candidateProviders);
}

/**
 * Metadata of the keys `getGatewayRoutedByokKeys` would load. Routing ranks these and decrypts only
 * the key it picks, so a key ranked below the serving route costs no decryption and cannot fail
 * the request.
 */
async function getGatewayRoutedByokKeyStates(
  user: User | AnonymousUserContext,
  requestedModel: string,
  options: GatewayRoutedByokOptions,
  loadKeyStates: () => Promise<ByokKeyState[]>
): Promise<ByokKeyState[]> {
  if (isAnonymousContext(user)) return [];
  const candidateProviders = await getAllowedGatewayRoutedByokProviders(requestedModel, options);
  if (candidateProviders.length === 0) return [];
  const keys = await loadKeyStates();
  return keys.filter(key => key.isEnabled && candidateProviders.includes(key.providerId));
}

/**
 * Whether the request's own `provider.ignore` names the Vercel provider of a key. Kilo's provider
 * preferences are added to the request later and never apply to the caller's keys.
 */
function createRequestIgnoreCheck(request: GatewayRequest) {
  const ignored = new Set(
    (request.body.provider?.ignore ?? []).map(openRouterToVercelInferenceProviderId)
  );
  return (providerId: UserByokProviderId) =>
    ignored.has(
      providerId === DirectUserByokInferenceProviderIdSchema.enum.codestral
        ? VercelUserByokInferenceProviderIdSchema.enum.mistral
        : providerId
    );
}

const noProviderAllowList = async () => undefined;
const everyDirectByokProviderAllowed = async () => true;

type GatewayKeyDecision = 'serves' | 'model-unavailable' | 'provider-settings';

/** Whether a whole-gateway key can serve the model, under the provider routing settings. */
function createGatewayKeyDecider(
  requestedModel: string,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
) {
  let gatewayProviders: Promise<readonly string[]> | undefined;
  return async (providerId: GatewayUserByokProviderId): Promise<GatewayKeyDecision> => {
    gatewayProviders ??= getModelGatewayUserByokProviders(requestedModel);
    if (!(await gatewayProviders).includes(providerId)) return 'model-unavailable';
    if (
      providerId === 'vercel-ai-gateway' &&
      !(await canRouteToVercel(requestedModel, getRoutingProviderConfig))
    ) {
      return 'provider-settings';
    }
    return 'serves';
  };
}

type ByokSkippedKey = { providerId: UserByokProviderId; reason: ByokCandidateSkipReason };

type ByokRoute<D, G> =
  | { route: 'direct-byok'; candidate: DirectByokCatalogCandidate<D> }
  | { route: 'vercel-byok'; key: G }
  | { route: 'gateway-byok'; key: G; providerId: GatewayUserByokProviderId };

/**
 * Every key that might serve the request, in the owner's route order (`createByokRouteRank` over
 * all of the owner's keys). The first that serves takes it.
 */
function rankByokRoutes<D extends ByokKeyState, G extends ByokKeyRef>(
  directCandidates: readonly DirectByokCatalogCandidate<D>[],
  gatewayRoutedKeys: readonly G[],
  ownerKeys: readonly ByokKeyRef[]
): ByokRoute<D, G>[] {
  const routes: ByokRoute<D, G>[] = [
    ...directCandidates.map(candidate => ({ route: 'direct-byok' as const, candidate })),
    ...gatewayRoutedKeys.map(key =>
      isGatewayUserByokProviderId(key.providerId)
        ? { route: 'gateway-byok' as const, key, providerId: key.providerId }
        : { route: 'vercel-byok' as const, key }
    ),
  ];
  const rank = createByokRouteRank(ownerKeys);
  const rankOf = (route: ByokRoute<D, G>) =>
    rank(route.route === 'direct-byok' ? route.candidate.key.providerId : route.key.providerId);
  return routes.toSorted((a, b) => rankOf(a) - rankOf(b));
}

async function gatewayRoutedByokResult(
  route: Exclude<ByokRoute<ByokKeyState, ByokKeyState>, { route: 'direct-byok' }>,
  key: BYOKResult,
  requestedModel: string
): Promise<GetProviderProviderResult> {
  return {
    kind: 'provider',
    provider:
      route.route === 'vercel-byok'
        ? VERCEL_AI_GATEWAY
        : route.providerId === 'vercel-ai-gateway'
          ? createUserVercelAiGatewayProvider(key.decryptedAPIKey)
          : createUserOpenRouterProvider(key.decryptedAPIKey),
    userByok: [key],
    isFree: await isFreeModel(requestedModel),
    bypassAccessCheck: false,
  };
}

function findUnsupportedApiKindCandidate<D, G>(routes: readonly ByokRoute<D, G>[]) {
  for (const route of routes) {
    if (route.route === 'direct-byok' && route.candidate.decision === 'unsupported-api-kind') {
      return route.candidate;
    }
  }
  return undefined;
}

export type GetProviderInput = {
  requestedModel: string;
  request: GatewayRequest;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  /** The platform caller for a service run; see `OpenAiChatGptRoutingInput`. */
  botId?: string | undefined;
  /** Resolves organization/group provider policy only when selecting a managed
   * gateway. Direct BYOK and custom LLM routes do not use it. */
  getRoutingProviderConfig?: () => Promise<OpenRouterProviderConfig | undefined>;
  /** Kilo's own provider exclusions for the model (see `getIgnoredProviders`).
   * They apply to routes Kilo pays for, never to a user's own gateway key. */
  kiloIgnoredProviders?: string[];
  /** The request carries a spend ceiling. Only a provider that can cap the
   * price of the route it serves may take it. */
  boundedSpending?: boolean;
  /** The OpenRouter provider slugs the organization policy allows for the model, or undefined
   * when it does not restrict providers. Provider keys sent through Vercel must honor it (see
   * `isVercelUserByokProviderAllowed`). */
  getAllowedProviders?: () => Promise<ReadonlySet<string> | undefined>;
  /** Whether the organization policy admits the model served by a catalog-mode direct BYOK key of
   * the provider it names (see `getDirectByokPolicyProviderId` and
   * `isModelAllowedForProviderKey`). Keys it rejects are skipped. */
  isDirectByokProviderAllowed?: (policyProviderId: string) => Promise<boolean>;
  /** The caller's Vercel IP country, for custom LLM country deny lists. */
  countryCode?: string | null;
  /** Receives the steps and BYOK candidates behind the result, when the call returns. */
  onDecision?: (decision: ProviderRoutingDecision) => void;
};

export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
  const { user, organizationId } = input;
  const decision = createRoutingDecisionRecorder({
    requested_model: input.requestedModel,
    api_kind: input.request.kind,
    owner_type: isAnonymousContext(user) ? 'anonymous' : organizationId ? 'organization' : 'user',
  });
  const result = await selectProvider(input, decision);
  if (input.onDecision) {
    try {
      input.onDecision(decision.finish(result));
    } catch (error) {
      console.error('[getProvider] failed to report the routing decision', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return result;
}

function byokRouteKey(route: ByokRoute<ByokKeyState, ByokKeyState>): ByokKeyState {
  return route.route === 'direct-byok' ? route.candidate.key : route.key;
}

/**
 * KEEP IN SYNC WITH `previewByokRouting` below. The BYOK settings page explains this route order
 * to users. Both share the key decisions (`rankDirectByokCatalogKeys`, `rankByokRoutes`,
 * `createGatewayKeyDecider`, `shouldRouteToVercel`), but each walks the steps itself, so a new step, a
 * reordered step, or a new reason to skip a key must be reflected in both, and recorded in `decision`.
 * `get-provider.preview.test.ts` runs both over the same keys and fails when they disagree.
 */
async function selectProvider(
  input: GetProviderInput,
  decision: RoutingDecisionRecorder
): Promise<GetProviderResult> {
  const {
    requestedModel,
    request,
    user,
    organizationId,
    botId,
    getRoutingProviderConfig,
    kiloIgnoredProviders = [],
    boundedSpending = false,
    countryCode = null,
    getAllowedProviders = noProviderAllowList,
    isDirectByokProviderAllowed = everyDirectByokProviderAllowed,
  } = input;

  if (isLocalFakeLlmEnabled() && isLocalFakeDeterministicModel(requestedModel)) {
    const localFakeProvider = getLocalFakeLlmProvider();
    if (localFakeProvider) {
      decision.step({ step: 'local-fake-llm', outcome: 'selected' });
      return {
        kind: 'provider',
        provider: localFakeProvider,
        userByok: null,
        isFree: true,
        bypassAccessCheck: true,
      };
    }
  }

  const customLlm = await findCustomLlm(requestedModel);
  if (customLlm) {
    return await resolveCustomLlmProvider(customLlm, user, organizationId, countryCode, decision);
  }
  decision.step({ step: 'custom-llm', outcome: 'skipped', reason: 'no-match' });

  let keyStates: Promise<ByokKeyState[]> | undefined;
  const loadKeyStates = () =>
    (keyStates ??= getByokKeyStates(readDb, byokOwner(user.id, organizationId)));
  const decryptCatalogKey = async (providerId: UserByokProviderId) =>
    (
      await getCatalogModeByokCredentials(readDb, byokOwner(user.id, organizationId), [providerId])
    ).find(credential => credential.providerId === providerId);

  const directByok = await resolveDirectByokProvider(
    user,
    requestedModel,
    request,
    organizationId,
    isDirectByokProviderAllowed,
    loadKeyStates,
    decision
  );
  if (directByok && directByok.kind !== 'direct-byok-catalog-candidates') {
    return directByok;
  }

  // A "Sign in with ChatGPT" connection is not in the key list. It takes an eligible OpenAI
  // responses request ahead of any provider or gateway key, but not ahead of a catalog-mode key
  // that the owner ranked first. A connection whose credential is terminally dead must fail
  // readably instead of resolving to another billing path.
  const checkChatGpt = async (): Promise<GetProviderResult | null> => {
    const openAiChatGptByok = await checkOpenAiChatGptByok({
      request,
      requestedModel,
      userId: isAnonymousContext(user) ? null : user.id,
      organizationId,
      botId,
    });
    if (openAiChatGptByok?.kind === 'reconnect') {
      decision.step({ step: 'chatgpt', outcome: 'rejected', reason: 'reconnect' });
      return { kind: 'chatgpt-reconnect', message: openAiChatGptByok.message };
    }
    if (!openAiChatGptByok) {
      decision.step({ step: 'chatgpt', outcome: 'skipped', reason: 'unavailable' });
      return null;
    }
    decision.step({ step: 'chatgpt', outcome: 'selected' });
    return { ...openAiChatGptByok, isFree: await isFreeModel(requestedModel) };
  };

  const directCandidates = directByok?.candidates ?? [];
  const catalogKeyServes = directCandidates.some(candidate => candidate.decision === 'serves');
  if (catalogKeyServes) {
    decision.step({ step: 'chatgpt', outcome: 'deferred', reason: 'catalog-key-serves' });
  } else {
    const chatGpt = await checkChatGpt();
    if (chatGpt) return chatGpt;
  }

  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;
  const decideGatewayKey = createGatewayKeyDecider(requestedModel, resolveRoutingProviderConfig);
  const gatewayRoutedKeys = await getGatewayRoutedByokKeyStates(
    user,
    requestedModel,
    {
      includeGatewayKeys: true,
      getAllowedProviders,
      onExcludedByPolicy: excluded =>
        decision.step({ step: 'organization-policy', excluded_provider_ids: excluded }),
    },
    loadKeyStates
  );
  const ownerKeys =
    directCandidates.length > 0 || gatewayRoutedKeys.length > 0 ? await loadKeyStates() : [];
  const routes = rankByokRoutes(directCandidates, gatewayRoutedKeys, ownerKeys);
  const routeOrder = createByokRouteRank(ownerKeys);
  decision.rankByokCandidates(
    routes.map(route => {
      const { providerId, priority } = byokRouteKey(route);
      return {
        route: route.route,
        provider_id: providerId,
        priority: priority ?? null,
        default_rank: getByokKeyDefaultRank(providerId),
        route_order: routeOrder(providerId),
        outcome: 'unreached',
      };
    })
  );
  // Skipped keys explain a route the settings page alone cannot: request-time inputs such as
  // `provider.ignore` or the provider settings decide them. Logged only when the order mattered.
  const skipped: ByokSkippedKey[] = [];
  const skip = (route: (typeof routes)[number], reason: ByokCandidateSkipReason) => {
    skipped.push({ providerId: byokRouteKey(route).providerId, reason });
    decision.markByokCandidate(routes.indexOf(route), 'skipped', reason);
  };
  const logSelection = (selected: string) => {
    if (routes.length > 1) {
      console.debug('[getProvider] BYOK route selected', {
        requestedModel,
        selected,
        candidates: routes.length,
        skipped,
      });
    }
  };
  const selectKey = (route: (typeof routes)[number]) => {
    const { providerId } = byokRouteKey(route);
    logSelection(providerId);
    decision.markByokCandidate(routes.indexOf(route), 'selected');
    decision.step({
      step: 'byok-key',
      outcome: 'selected',
      route: route.route,
      provider_id: providerId,
    });
  };
  const keyNotLoaded = (route: (typeof routes)[number]) => {
    console.warn('[getProvider] BYOK key ranked for the request could not be loaded', {
      requestedModel,
      providerId: byokRouteKey(route).providerId,
    });
    skip(route, 'not-loaded');
  };

  const takeGatewayRoutedRoute = async (
    route: Exclude<(typeof routes)[number], { route: 'direct-byok' }>
  ): Promise<GetProviderResult | null> => {
    const chatGpt = catalogKeyServes ? await checkChatGpt() : null;
    if (chatGpt) {
      logSelection(OPENAI_CHATGPT_PROVIDER_ID);
      return chatGpt;
    }
    if (isAnonymousContext(user)) return null;
    const { providerId } = route.key;
    const key = (await decryptGatewayRoutedByokKeys(user.id, organizationId, [providerId])).find(
      byok => byok.providerId === providerId
    );
    if (!key) {
      keyNotLoaded(route);
      return null;
    }
    selectKey(route);
    return gatewayRoutedByokResult(route, key, requestedModel);
  };

  // The request's `provider.ignore` is a preference: an ignored provider key yields to any later
  // route that serves, but still serves when nothing else does, so it never bills Kilo instead.
  const isIgnoredByRequest = createRequestIgnoreCheck(request);
  let firstIgnoredRoute: Extract<(typeof routes)[number], { route: 'vercel-byok' }> | undefined;
  for (const route of routes) {
    if (route.route === 'direct-byok') {
      const { provider, model, key, decision: keyDecision } = route.candidate;
      if (keyDecision !== 'serves') {
        skip(route, keyDecision);
        continue;
      }
      const credential = await decryptCatalogKey(key.providerId);
      if (!credential) {
        keyNotLoaded(route);
        continue;
      }
      selectKey(route);
      return directByokProviderResult(provider, model, credential, requestedModel, request, true);
    }
    if (route.route === 'gateway-byok') {
      const keyDecision = await decideGatewayKey(route.providerId);
      if (keyDecision !== 'serves') {
        skip(route, keyDecision);
        continue;
      }
    }
    if (route.route === 'vercel-byok' && isIgnoredByRequest(route.key.providerId)) {
      skip(route, 'ignored-by-request');
      firstIgnoredRoute ??= route;
      continue;
    }
    const result = await takeGatewayRoutedRoute(route);
    if (result) return result;
  }
  if (firstIgnoredRoute) {
    console.warn('[getProvider] Using a BYOK key the request ignores, since no other key serves', {
      requestedModel,
      providerId: firstIgnoredRoute.key.providerId,
    });
    const result = await takeGatewayRoutedRoute(firstIgnoredRoute);
    if (result) return result;
  }
  decision.step({
    step: 'byok-key',
    outcome: 'skipped',
    reason: routes.length === 0 ? 'no-candidates' : 'none-served',
  });

  // BYOK requests are never billed to Kilo, so a catalog id the caller's keys serve, but not over
  // this API kind, fails with the unsupported-API error instead of taking a Kilo route.
  const unsupported = findUnsupportedApiKindCandidate(routes);
  if (unsupported) {
    const { provider, model, key } = unsupported;
    const credential = await decryptCatalogKey(key.providerId);
    const unsupportedKey = {
      step: 'unsupported-api-kind',
      provider_id: key.providerId,
      supported_api_kinds: [...getDirectByokModelChatApis(provider, model)],
    } satisfies Partial<RoutingDecisionStep>;
    if (credential) {
      decision.markByokCandidate(
        routes.findIndex(route => route.route === 'direct-byok' && route.candidate === unsupported),
        'selected'
      );
      decision.step({ ...unsupportedKey, outcome: 'selected' });
      return directByokProviderResult(provider, model, credential, requestedModel, request, true);
    }
    decision.step({ ...unsupportedKey, outcome: 'skipped', reason: 'not-loaded' });
  }

  const kiloRouteUsesVercel = await shouldRouteToVercel(
    requestedModel,
    async () => withIgnoredProviders(await resolveRoutingProviderConfig(), kiloIgnoredProviders),
    boundedSpending
  );
  decision.step({
    step: 'kilo',
    outcome: 'selected',
    gateway: kiloRouteUsesVercel ? 'vercel' : 'openrouter',
    bounded_spending: boundedSpending,
    kilo_ignored_providers: kiloIgnoredProviders,
  });
  return {
    kind: 'provider',
    provider: kiloRouteUsesVercel ? VERCEL_AI_GATEWAY : OPENROUTER,
    userByok: null,
    isFree: await isFreeModel(requestedModel),
    bypassAccessCheck: false,
  };
}

/**
 * `used`: the step takes the request. `unreached`: it would, but an earlier step takes it.
 * `conditional`: it takes the request only when a credential outside the key list, such as a
 * member's ChatGPT connection, is usable.
 */
const ByokRoutePreviewOutcomeSchema = z.enum(['used', 'skipped', 'unreached', 'conditional']);

export const ByokRoutePreviewStepSchema = z.discriminatedUnion('route', [
  z.object({
    route: z.literal('direct-byok'),
    outcome: ByokRoutePreviewOutcomeSchema,
    providerId: UserByokProviderIdSchema,
    reason: z.enum(['serves', 'unsupported-api-kind', 'disabled', 'not-catalog-mode']),
    supportedApiKinds: z.array(GatewayChatApiKindSchema),
  }),
  z.object({ route: z.literal('chatgpt'), outcome: ByokRoutePreviewOutcomeSchema }),
  z.object({
    route: z.literal('vercel-byok'),
    outcome: ByokRoutePreviewOutcomeSchema,
    providerIds: z.array(UserByokProviderIdSchema),
    reason: z.enum(['serves', 'disabled']),
  }),
  z.object({
    route: z.literal('gateway-byok'),
    outcome: ByokRoutePreviewOutcomeSchema,
    providerId: GatewayUserByokProviderIdSchema,
    reason: z.enum(['serves', 'disabled', 'model-unavailable', 'provider-settings']),
  }),
  z.object({
    route: z.literal('unsupported-api-kind'),
    outcome: ByokRoutePreviewOutcomeSchema,
    providerId: UserByokProviderIdSchema,
    supportedApiKinds: z.array(GatewayChatApiKindSchema),
  }),
  z.object({
    route: z.literal('kilo'),
    outcome: ByokRoutePreviewOutcomeSchema,
    gateway: z.enum(['vercel', 'openrouter']),
  }),
]);

export type ByokRoutePreviewStep = z.infer<typeof ByokRoutePreviewStepSchema>;

export const ByokRoutingPreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('routes'), steps: z.array(ByokRoutePreviewStepSchema) }),
  /** A custom LLM owns its id, so no BYOK key or Kilo route applies. */
  z.object({ kind: z.literal('custom-llm') }),
  z.object({ kind: z.literal('not-catalog-model') }),
]);

export type ByokRoutingPreview = z.infer<typeof ByokRoutingPreviewSchema>;

function markUnreachedSteps(steps: ByokRoutePreviewStep[]): ByokRoutePreviewStep[] {
  let taken = false;
  return steps.map(step => {
    if (step.outcome !== 'used' && step.outcome !== 'conditional') return step;
    if (taken) return { ...step, outcome: 'unreached' };
    if (step.outcome === 'used') taken = true;
    return step;
  });
}

/**
 * The routes `getProvider` would try for a catalog model, in order, for the BYOK settings page.
 * Reads key metadata only: it never decrypts a key or calls KMS. Organization model and provider
 * policies are not applied, so Kilo's gateway and the Vercel AI Gateway key assume no provider
 * restrictions. A ChatGPT connection is personal and its state is encrypted, so it is reported as
 * conditional.
 *
 * KEEP IN SYNC WITH `selectProvider` above: mirror any change to its step order or key decisions.
 */
export async function previewByokRouting({
  fromDb,
  owner,
  requestedModel,
  apiKind,
}: {
  /** The settings page passes the primary, so the preview matches the key list it explains. */
  fromDb: ByokSourceDb;
  owner: ByokOwner;
  requestedModel: string;
  apiKind: GatewayChatApiKind;
}): Promise<ByokRoutingPreview> {
  if (await findCustomLlm(requestedModel)) return { kind: 'custom-llm' };
  const { provider: bespokeProvider } = await getDirectByokModel(requestedModel);
  if (bespokeProvider || !(await isValidOpenRouterModelId(requestedModel))) {
    return { kind: 'not-catalog-model' };
  }

  const keys = await getByokKeyStates(fromDb, owner);
  const candidateProviders = await getGatewayRoutedByokCandidateProviders(requestedModel, {
    includeGatewayKeys: true,
  });
  const routes = rankByokRoutes(
    rankDirectByokCatalogKeys(await findDirectByokCatalogModels(requestedModel), keys, apiKind),
    keys.filter(key => candidateProviders.includes(key.providerId)),
    keys
  );
  const noProviderRestrictions = async () => undefined;
  const decideGatewayKey = createGatewayKeyDecider(requestedModel, noProviderRestrictions);

  const steps: ByokRoutePreviewStep[] = [];
  for (const route of routes) {
    switch (route.route) {
      case 'direct-byok': {
        const { provider, model, key, decision } = route.candidate;
        steps.push({
          route: 'direct-byok',
          outcome: decision === 'serves' ? 'used' : 'skipped',
          providerId: key.providerId,
          reason: decision,
          supportedApiKinds: [...getDirectByokModelChatApis(provider, model)],
        });
        break;
      }
      case 'vercel-byok':
        steps.push({
          route: 'vercel-byok',
          outcome: route.key.isEnabled ? 'used' : 'skipped',
          providerIds: [route.key.providerId],
          reason: route.key.isEnabled ? 'serves' : 'disabled',
        });
        break;
      case 'gateway-byok': {
        const reason = route.key.isEnabled ? await decideGatewayKey(route.providerId) : 'disabled';
        steps.push({
          route: 'gateway-byok',
          outcome: reason === 'serves' ? 'used' : 'skipped',
          providerId: route.providerId,
          reason,
        });
        break;
      }
    }
  }

  if (await getOpenAiChatGptCandidateModel(apiKind, requestedModel)) {
    const firstGatewayRouted = steps.findIndex(
      step => step.route !== 'direct-byok' && step.outcome === 'used'
    );
    steps.splice(firstGatewayRouted === -1 ? steps.length : firstGatewayRouted, 0, {
      route: 'chatgpt',
      outcome: 'conditional',
    });
  }

  // A catalog-mode key that serves makes the failure impossible. Below any other serving key,
  // `markUnreachedSteps` marks it not tried.
  const unsupported = routes.some(
    route => route.route === 'direct-byok' && route.candidate.decision === 'serves'
  )
    ? undefined
    : findUnsupportedApiKindCandidate(routes);
  if (unsupported) {
    steps.push({
      route: 'unsupported-api-kind',
      outcome: 'used',
      providerId: unsupported.key.providerId,
      supportedApiKinds: [...getDirectByokModelChatApis(unsupported.provider, unsupported.model)],
    });
  }

  const kiloRouteUsesVercel = await shouldRouteToVercel(
    requestedModel,
    noProviderRestrictions,
    // The preview explains the unrestricted route, so no request can carry a spend ceiling here.
    false
  );
  steps.push({
    route: 'kilo',
    outcome: 'used',
    gateway: kiloRouteUsesVercel ? 'vercel' : 'openrouter',
  });
  return { kind: 'routes', steps: markUnreachedSteps(steps) };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  allowedProviders?: ReadonlySet<string>
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; isFree: boolean }> {
  const isFree = await isFreeModel(requestedModel);
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const inference = await getGatewayRoutedByokKeys(user, requestedModel, organizationId, {
    includeGatewayKeys: false,
    getAllowedProviders: async () => allowedProviders,
  });
  if (inference.length > 0) {
    return { provider: VERCEL_AI_GATEWAY, userByok: inference, isFree };
  }

  // 2. All non-BYOK embedding requests go through OpenRouter
  return { provider: OPENROUTER, userByok: null, isFree };
}

export async function getTranscriptionProvider(): Promise<{
  provider: Provider;
  userByok: BYOKResult[] | null;
}> {
  if (isLocalFakeLlmEnabled()) {
    const localFakeProvider = getLocalFakeTranscriptionProvider();
    if (localFakeProvider) {
      return { provider: localFakeProvider, userByok: null };
    }
  }
  return { provider: OPENROUTER, userByok: null };
}
