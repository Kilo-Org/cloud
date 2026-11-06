import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  getRequestIgnoredVercelProviderIds,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  byokOwner,
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getByokKeyStates,
  getStoredByokKeys,
  type ByokOwner,
  type ByokSourceDb,
  type StoredByokKeys,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  createRoutingDecisionRecorder,
  type ByokCandidateSkipReason,
  type ProviderRoutingDecision,
  type RoutingDecisionRecorder,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  classifyRequestedModel,
  getAllowedGatewayRoutedByokProviders,
  isKeyPlanStep,
  planRoutes,
  type GatewayByokPlanStep,
  type KeyPlanStep,
  type RoutePlanInputs,
  type RoutePlanStep,
  type VercelByokPlanStep,
} from '@kilocode/web-shared/lib/ai-gateway/providers/route-plan';
import { shouldRouteToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { withIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
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
  getDirectByokCatalogModelId,
  getDirectByokPolicyProviderId,
  getDirectByokModelChatApis,
  supportsCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { checkOpenAiChatGptByok } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { checkClaudeBilling } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/routing';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import * as z from 'zod';
import { CustomLlmCredentialsSchema, type CustomLlmCredentials } from '@kilocode/db/schema-types';
import {
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
  /**
   * The owner's Claude billing connection cannot bill. Serving the request any
   * other way would spend a different payer's allowance without telling them.
   */
  | { kind: 'claude-billing-unavailable'; message: string; retryable?: boolean }
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
      inferenceProviderId: getDirectByokPolicyProviderId(directByok),
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        delete context.request.body.provider;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok: [{ decryptedAPIKey: credential.decryptedAPIKey, providerId: credential.providerId }],
    isFree: isFreeModel(requestedModel),
    // Organization model and provider policies cover catalog ids. A bespoke id is only served by a
    // key outside catalog mode, which stays exempt as before.
    bypassAccessCheck: !servesCatalogId,
  };
}

/**
 * Direct BYOK model IDs name their provider, such as `neuralwatt/...`, and the request goes straight
 * to that provider with the stored key, bypassing Kilo's gateways. A key in catalog mode instead
 * serves the catalog ids its provider maps.
 */
async function resolveDirectByokModel(
  directByok: DirectByokProvider,
  directByokModel: DirectByokModel,
  { user, organizationId, requestedModel, request }: GetProviderInput,
  decision: RoutingDecisionRecorder
): Promise<GetProviderProviderResult | DirectByokCatalogOnlyResult | null> {
  const providerId = directByok.id;
  const [credential] = await getByokCredentials(readDb, byokOwner(user.id, organizationId), [
    providerId,
  ]);
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

async function isEligibleForCustomLlm(
  customLlm: CustomLlm,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
) {
  // An anonymous caller has no balance to bill.
  if (isAnonymousContext(user))
    return isPublicCustomLlm(customLlm.definition) && isFreeModel(customLlm.public_id);
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
    isFree: isFreeModel(customLlm.public_id),
    bypassAccessCheck: !isPublic,
  };
}

/**
 * A public custom LLM serves anyone on Kilo's credential, so like free models it
 * drops paid server features before the definition's own `extra_body` applies,
 * even when it sets pricing. Private custom LLMs keep them unless their id is free.
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

function gatewayRoutedByokResult(
  step: VercelByokPlanStep | GatewayByokPlanStep,
  key: BYOKResult,
  requestedModel: string
): GetProviderProviderResult {
  return {
    kind: 'provider',
    provider:
      step.route === 'vercel-byok'
        ? VERCEL_AI_GATEWAY
        : step.providerId === 'vercel-ai-gateway'
          ? createUserVercelAiGatewayProvider(key.decryptedAPIKey)
          : createUserOpenRouterProvider(key.decryptedAPIKey),
    userByok: [key],
    isFree: isFreeModel(requestedModel),
    bypassAccessCheck: false,
  };
}

export type GetProviderInput = {
  requestedModel: string;
  request: GatewayRequest;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  /** The platform caller for a service run; see `OpenAiChatGptRoutingInput`. */
  botId?: string | undefined;
  /** The provider routing settings, from the organization or group policy and otherwise the
   * request's own `provider`. Decides whether the Vercel AI Gateway key serves and which gateway
   * Kilo's route uses. Direct BYOK and custom LLM routes do not use it. */
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>;
  /** Kilo's own provider exclusions for the model (see `getIgnoredProviders`).
   * They apply to routes Kilo pays for, never to a user's own gateway key. */
  kiloIgnoredProviders?: string[];
  /** The request carries a spend ceiling. Only a provider that can cap the
   * price of the route it serves may take it. */
  boundedSpending?: boolean;
  /** The OpenRouter provider slugs the organization policy allows for the model, or undefined
   * when it does not restrict providers. Provider keys sent through Vercel must honor it (see
   * `isVercelUserByokProviderAllowed`). */
  getAllowedProviders: () => Promise<ReadonlySet<string> | undefined>;
  /** Whether the organization policy admits the model served by a catalog-mode direct BYOK key of
   * the provider it names (see `getDirectByokPolicyProviderId` and
   * `isModelAllowedForProviderKey`). Keys it rejects are skipped. */
  isDirectByokProviderAllowed: (policyProviderId: string) => Promise<boolean>;
  /** Kilo's own route falls back to OpenRouter, like the global Vercel routing switch. BYOK routes
   * are unaffected; the caller rejects a route through a disabled gateway. */
  organizationDisabledVercelAiGateway: boolean;
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

/** Why routing passes over a key at its own rank, or null when the key takes the request there. */
function reasonToPass(step: KeyPlanStep): ByokCandidateSkipReason | null {
  if (step.decision !== 'serves') return step.decision;
  return step.route === 'vercel-byok' && step.ignoredByRequest ? 'ignored-by-request' : null;
}

type ByokSkippedKey = { providerId: UserByokProviderId; reason: ByokCandidateSkipReason };

/**
 * Serves the request with the first step of its route plan that can take it. The plan is built from
 * key metadata; only the key that takes the request is decrypted, and the ChatGPT connection is
 * read only when routing reaches it.
 */
async function selectProvider(
  input: GetProviderInput,
  decision: RoutingDecisionRecorder
): Promise<GetProviderResult> {
  const { requestedModel, request, user, organizationId, botId } = input;

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

  const model = await classifyRequestedModel(requestedModel);
  if (model.kind === 'custom-llm') {
    return await resolveCustomLlmProvider(
      model.customLlm,
      user,
      organizationId,
      input.countryCode ?? null,
      decision
    );
  }
  decision.step({ step: 'custom-llm', outcome: 'skipped', reason: 'no-match' });
  if (model.kind === 'direct-byok-model') {
    const result = await resolveDirectByokModel(model.provider, model.model, input, decision);
    if (result) return result;
  } else {
    decision.step({ step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' });
  }

  const claudeBilling = await checkClaudeBilling({
    request,
    requestedModel,
    userId: isAnonymousContext(user) ? null : user.id,
    requesterEmail: isAnonymousContext(user) ? null : user.google_user_email,
    organizationId,
  });
  if (claudeBilling?.kind === 'unavailable') {
    decision.step({ step: 'claude-billing', outcome: 'rejected', reason: 'unavailable' });
    return {
      kind: 'claude-billing-unavailable',
      message: claudeBilling.message,
      retryable: claudeBilling.retryable,
    };
  }
  if (claudeBilling) {
    decision.step({ step: 'claude-billing', outcome: 'selected' });
    return {
      kind: 'provider',
      provider: claudeBilling.provider,
      userByok: null,
      isFree: isFreeModel(requestedModel),
      bypassAccessCheck: false,
      skipBalanceCheck: true,
    };
  }

  let storedKeys: Promise<StoredByokKeys> | undefined;
  const loadStoredKeys = () =>
    (storedKeys ??= getStoredByokKeys(readDb, byokOwner(user.id, organizationId)));
  const planInputs = {
    requestedModel,
    apiKind: request.kind,
    loadKeys: isAnonymousContext(user) ? null : async () => (await loadStoredKeys()).keys,
    isDirectByokProviderAllowed: input.isDirectByokProviderAllowed,
    getAllowedProviders: input.getAllowedProviders,
    getRoutingProviderConfig: input.getRoutingProviderConfig,
    requestIgnoredProviders: getRequestIgnoredVercelProviderIds(request.body.provider),
    onExcludedByPolicy: excluded =>
      decision.step({ step: 'organization-policy', excluded_provider_ids: excluded }),
  } satisfies RoutePlanInputs;
  const plan = await planRoutes(planInputs);
  const keySteps = plan.filter(isKeyPlanStep);
  decision.recordByokCandidates(keySteps);
  const chatGptIndex = plan.findIndex(step => step.route === 'chatgpt');
  if (
    plan
      .slice(0, Math.max(chatGptIndex, 0))
      .some(step => step.route === 'direct-byok' && step.decision === 'serves')
  ) {
    decision.step({ step: 'chatgpt', outcome: 'deferred', reason: 'catalog-key-serves' });
  }

  // Skipped keys explain a route the settings page alone cannot: request-time inputs such as
  // `provider.ignore` or the provider settings decide them. Logged only when the order mattered.
  const skipped: ByokSkippedKey[] = [];
  const logSelection = (selected: string) => {
    if (keySteps.length > 1) {
      console.debug('[getProvider] BYOK route selected', {
        requestedModel,
        selected,
        candidates: keySteps.length,
        skipped,
      });
    }
  };
  const decryptKey = async (step: KeyPlanStep) =>
    (await loadStoredKeys()).decrypt(step.key.providerId);

  const takeKey = async (step: KeyPlanStep): Promise<GetProviderProviderResult> => {
    const credential = await decryptKey(step);
    const { providerId } = step.key;
    logSelection(providerId);
    decision.markByokCandidate(step, 'selected');
    decision.step({
      step: 'byok-key',
      outcome: 'selected',
      route: step.route,
      provider_id: providerId,
    });
    return step.route === 'direct-byok'
      ? directByokProviderResult(
          step.provider,
          step.model,
          credential,
          requestedModel,
          request,
          true
        )
      : gatewayRoutedByokResult(step, credential, requestedModel);
  };

  // A connection whose credential is terminally dead must fail readably instead of resolving to
  // another billing path.
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
    logSelection(OPENAI_CHATGPT_PROVIDER_ID);
    return { ...openAiChatGptByok, isFree: isFreeModel(requestedModel) };
  };

  const recordNoKeyServed = () =>
    decision.step({
      step: 'byok-key',
      outcome: 'skipped',
      reason: keySteps.length === 0 ? 'no-candidates' : 'none-served',
    });

  for (const step of plan) {
    switch (step.route) {
      case 'direct-byok':
      case 'vercel-byok':
      case 'gateway-byok': {
        const reason = reasonToPass(step);
        if (!reason) return await takeKey(step);
        skipped.push({ providerId: step.key.providerId, reason });
        decision.markByokCandidate(step, 'skipped', reason);
        break;
      }
      case 'chatgpt': {
        const chatGpt = await checkChatGpt();
        if (chatGpt) return chatGpt;
        break;
      }
      case 'ignored-key-fallback':
        console.warn(
          '[getProvider] Using a BYOK key the request ignores, since no other key serves',
          { requestedModel, providerId: step.step.key.providerId }
        );
        return await takeKey(step.step);
      case 'unsupported-api-kind': {
        recordNoKeyServed();
        const { provider, model, key } = step.step;
        const credential = await decryptKey(step.step);
        decision.markByokCandidate(step.step, 'selected');
        decision.step({
          step: 'unsupported-api-kind',
          outcome: 'selected',
          provider_id: key.providerId,
          supported_api_kinds: [...getDirectByokModelChatApis(provider, model)],
        });
        return directByokProviderResult(provider, model, credential, requestedModel, request, true);
      }
      case 'kilo': {
        recordNoKeyServed();
        const { kiloIgnoredProviders = [], boundedSpending = false } = input;
        const { organizationDisabledVercelAiGateway } = input;
        const routesToVercel = await shouldRouteToVercel(
          { requestedModel, boundedSpending, organizationDisabledVercelAiGateway },
          async () =>
            withIgnoredProviders(await input.getRoutingProviderConfig(), kiloIgnoredProviders)
        );
        decision.step({
          step: 'kilo',
          outcome: 'selected',
          gateway: routesToVercel ? 'vercel' : 'openrouter',
          bounded_spending: boundedSpending,
          organization_disabled_vercel_ai_gateway: organizationDisabledVercelAiGateway,
          kilo_ignored_providers: kiloIgnoredProviders,
        });
        return {
          kind: 'provider',
          provider: routesToVercel ? VERCEL_AI_GATEWAY : OPENROUTER,
          userByok: null,
          isFree: isFreeModel(requestedModel),
          bypassAccessCheck: false,
        };
      }
    }
  }
  throw new Error('A route plan always ends with the Kilo step');
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

async function previewStep(
  step: RoutePlanStep,
  requestedModel: string
): Promise<ByokRoutePreviewStep[]> {
  switch (step.route) {
    case 'direct-byok':
      return [
        {
          route: 'direct-byok',
          outcome: step.decision === 'serves' ? 'used' : 'skipped',
          providerId: step.key.providerId,
          reason: step.decision,
          supportedApiKinds: [...getDirectByokModelChatApis(step.provider, step.model)],
        },
      ];
    case 'vercel-byok':
      return [
        {
          route: 'vercel-byok',
          outcome: step.decision === 'serves' ? 'used' : 'skipped',
          providerIds: [step.key.providerId],
          reason: step.decision,
        },
      ];
    case 'gateway-byok':
      return [
        {
          route: 'gateway-byok',
          outcome: step.decision === 'serves' ? 'used' : 'skipped',
          providerId: step.providerId,
          reason: step.decision,
        },
      ];
    case 'chatgpt':
      return [{ route: 'chatgpt', outcome: 'conditional' }];
    // The preview ignores no provider, so its plan never falls back to an ignored key.
    case 'ignored-key-fallback':
      return [];
    case 'unsupported-api-kind':
      return [
        {
          route: 'unsupported-api-kind',
          outcome: 'used',
          providerId: step.step.key.providerId,
          supportedApiKinds: [...getDirectByokModelChatApis(step.step.provider, step.step.model)],
        },
      ];
    case 'kilo':
      return [
        {
          route: 'kilo',
          outcome: 'used',
          // The preview explains the unrestricted route, so no request can carry a spend ceiling here.
          gateway: (await shouldRouteToVercel(
            { requestedModel, boundedSpending: false, organizationDisabledVercelAiGateway: false },
            async () => undefined
          ))
            ? 'vercel'
            : 'openrouter',
        },
      ];
  }
}

/**
 * The route plan `getProvider` would follow for a catalog model, for the BYOK settings page. Reads
 * key metadata only: it never decrypts a key or calls KMS. Organization model and provider
 * policies are not applied, so Kilo's gateway and the Vercel AI Gateway key assume no provider
 * restrictions, and no request-time `provider.ignore` or spend ceiling applies. A ChatGPT connection
 * is personal and its state is encrypted, so it is reported as conditional.
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
  const model = await classifyRequestedModel(requestedModel);
  if (model.kind === 'custom-llm') return { kind: 'custom-llm' };
  if (model.kind === 'direct-byok-model' || !(await isValidOpenRouterModelId(requestedModel))) {
    return { kind: 'not-catalog-model' };
  }

  const inputs = {
    requestedModel,
    apiKind,
    loadKeys: () => getByokKeyStates(fromDb, owner),
    isDirectByokProviderAllowed: async () => true,
    getAllowedProviders: async () => undefined,
    getRoutingProviderConfig: async () => undefined,
    requestIgnoredProviders: new Set<string>(),
  } satisfies RoutePlanInputs;
  const steps = await Promise.all(
    (await planRoutes(inputs)).map(step => previewStep(step, requestedModel))
  );
  return { kind: 'routes', steps: markUnreachedSteps(steps.flat()) };
}

async function getGatewayRoutedByokKeys(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined,
  allowedProviders: ReadonlySet<string> | undefined
): Promise<BYOKResult[]> {
  if (isAnonymousContext(user)) return [];
  const providerIds = await getAllowedGatewayRoutedByokProviders(requestedModel, {
    includeGatewayKeys: false,
    getAllowedProviders: async () => allowedProviders,
  });
  if (providerIds.length === 0) return [];
  return (
    (organizationId
      ? await getBYOKforOrganization(readDb, organizationId, providerIds)
      : await getBYOKforUser(readDb, user.id, providerIds)) ?? []
  );
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  allowedProviders?: ReadonlySet<string>
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; isFree: boolean }> {
  const isFree = isFreeModel(requestedModel);
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const inference = await getGatewayRoutedByokKeys(
    user,
    requestedModel,
    organizationId,
    allowedProviders
  );
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
