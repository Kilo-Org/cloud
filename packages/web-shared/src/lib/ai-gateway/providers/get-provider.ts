import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  isGatewayUserByokProviderId,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { withIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
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
import { sortByokKeysInRouteOrder } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import type {
  BYOKResult,
  GatewayChatApiKind,
  Provider,
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
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
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
  /** Skip balance, paid-auth, and organization policy checks entirely. Used
   *  by bespoke direct-byok ids and non-public custom_llm2 because both already
   *  require explicit admin opt-in. */
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
      id: 'direct-byok',
      ...upstream,
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        delete context.request.body.provider;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok: [{ decryptedAPIKey: credential.decryptedAPIKey, providerId: credential.providerId }],
    isFree: isFreeModelExcludingCustomLlms(requestedModel),
    // Organization model policies cover catalog ids. A bespoke id is only served by a key outside
    // catalog mode, which stays exempt as before.
    bypassAccessCheck: !servesCatalogId,
  };
}

type RoutingCatalogKey = Awaited<ReturnType<typeof getCatalogModeByokCredentials>>[number] & {
  isEnabled: true;
};

/** A catalog id: the caller's catalog-mode keys for it, ranked with their other keys by the caller. */
type DirectByokCatalogCandidates = {
  kind: 'direct-byok-catalog-candidates';
  candidates: DirectByokCatalogCandidate<RoutingCatalogKey>[];
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
  organizationId: string | undefined
): Promise<
  GetProviderProviderResult | DirectByokCatalogOnlyResult | DirectByokCatalogCandidates | null
> {
  const owner = byokOwner(user.id, organizationId);
  const { provider: directByok, model: directByokModel } = await getDirectByokModel(requestedModel);
  if (directByok && directByokModel) {
    const [credential] = await getByokCredentials(readDb, owner, [directByok.id]);
    if (!credential) return null;
    if (credential.serveCatalogModels && supportsCatalogMode(directByok.id)) {
      return {
        kind: 'direct-byok-catalog-only',
        providerId: directByok.id,
        catalogModelId: await getDirectByokCatalogModelId(directByokModel),
      };
    }
    return directByokProviderResult(
      directByok,
      directByokModel,
      credential,
      requestedModel,
      request,
      false
    );
  }

  if (isAnonymousContext(user)) return null;
  const catalogModels = await findDirectByokCatalogModels(requestedModel);
  if (catalogModels.length === 0) return null;
  const credentials = await getCatalogModeByokCredentials(
    readDb,
    owner,
    catalogModels.map(({ provider }) => provider.id)
  );
  return {
    kind: 'direct-byok-catalog-candidates',
    candidates: rankDirectByokCatalogKeys(
      catalogModels,
      credentials.map(credential => ({ ...credential, isEnabled: true as const })),
      request.kind
    ),
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
  if (isPublicCustomLlm(customLlm.definition)) return true;
  if (isAnonymousContext(user) || !organizationId) return false;
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
  countryCode: string | null
): Promise<GetProviderResult> {
  if (isCustomLlmDeniedInCountry(customLlm.definition, countryCode)) {
    return { kind: 'custom-llm-unavailable' };
  }
  if (!(await isEligibleForCustomLlm(customLlm, user, organizationId))) {
    return { kind: 'custom-llm-unavailable' };
  }
  const credentials = readCustomLlmCredentials(customLlm);
  if (!credentials) {
    console.error('Custom LLM credentials are missing or invalid', customLlm.public_id);
    return { kind: 'custom-llm-unavailable' };
  }

  const { definition } = customLlm;
  const provider = buildDirectProvider(
    'custom',
    getCustomLlmApiKinds(definition),
    definition,
    await resolveCustomLlmAuth(credentials)
  );
  const isPublic = isPublicCustomLlm(definition);
  return {
    kind: 'provider',
    provider: isPublic ? withoutPaidServerFeatures(provider) : provider,
    userByok: null,
    isFree: true,
    bypassAccessCheck: !isPublic,
  };
}

/**
 * A public custom LLM serves anyone for free on Kilo's credential, so like other
 * free models it drops paid server features before the definition's own
 * `extra_body` applies. Private custom LLMs keep them.
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
  // Kilo-exclusive models stay on Kilo's own accounts, like in `getModelGatewayUserByokProviders`.
  if (isKiloExclusiveModel(requestedModel)) return [];
  return [
    ...(await getModelInferenceUserByokProviders(requestedModel)),
    ...(includeGatewayKeys && isGatewayUserByokEligibleModel(requestedModel)
      ? GatewayUserByokProviderIdSchema.options
      : []),
  ];
}

/** The enabled provider keys sent through Vercel and whole-gateway keys that may serve the model. */
async function getGatewayRoutedByokKeys(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined,
  options: { includeGatewayKeys: boolean }
): Promise<BYOKResult[]> {
  if (isAnonymousContext(user)) return [];
  const candidateProviders = await getGatewayRoutedByokCandidateProviders(requestedModel, options);
  if (candidateProviders.length === 0) return [];
  return (
    (organizationId
      ? await getBYOKforOrganization(readDb, organizationId, candidateProviders)
      : await getBYOKforUser(readDb, user.id, candidateProviders)) ?? []
  );
}

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

type ByokRoute<D, G> =
  | { route: 'direct-byok'; candidate: DirectByokCatalogCandidate<D> }
  | { route: 'vercel-byok'; key: G }
  | { route: 'gateway-byok'; key: G; providerId: GatewayUserByokProviderId };

/** Every key that might serve the request, in the owner's route order. The first that serves takes it. */
function rankByokRoutes<D extends ByokKeyState, G extends ByokKeyRef>(
  directCandidates: readonly DirectByokCatalogCandidate<D>[],
  gatewayRoutedKeys: readonly G[]
): ByokRoute<D, G>[] {
  const routes: ByokRoute<D, G>[] = [
    ...directCandidates.map(candidate => ({ route: 'direct-byok' as const, candidate })),
    ...gatewayRoutedKeys.map(key =>
      isGatewayUserByokProviderId(key.providerId)
        ? { route: 'gateway-byok' as const, key, providerId: key.providerId }
        : { route: 'vercel-byok' as const, key }
    ),
  ];
  return sortByokKeysInRouteOrder(routes, route =>
    route.route === 'direct-byok' ? route.candidate.key : route.key
  );
}

function gatewayRoutedByokResult(
  route: Exclude<ByokRoute<ByokKeyState, BYOKResult>, { route: 'direct-byok' }>,
  requestedModel: string
): GetProviderProviderResult {
  const { key } = route;
  return {
    kind: 'provider',
    provider:
      route.route === 'vercel-byok'
        ? VERCEL_AI_GATEWAY
        : route.providerId === 'vercel-ai-gateway'
          ? createUserVercelAiGatewayProvider(key.decryptedAPIKey)
          : createUserOpenRouterProvider(key.decryptedAPIKey),
    userByok: [key],
    isFree: isFreeModelExcludingCustomLlms(requestedModel),
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

/** The gateway of Kilo's own route, used when no BYOK route takes the request. */
async function selectKiloGateway(
  requestedModel: string,
  boundedSpending: boolean,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
): Promise<'vercel' | 'openrouter'> {
  return !boundedSpending && (await shouldRouteToVercel(requestedModel, getRoutingProviderConfig))
    ? 'vercel'
    : 'openrouter';
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
  /** The caller's Vercel IP country, for custom LLM country deny lists. */
  countryCode?: string | null;
};

/**
 * KEEP IN SYNC WITH `previewByokRouting` below. The BYOK settings page explains this route order
 * to users. Both share the key decisions (`rankDirectByokCatalogKeys`, `rankByokRoutes`,
 * `createGatewayKeyDecider`, `selectKiloGateway`), but each walks the steps itself, so a new step, a
 * reordered step, or a new reason to skip a key must be reflected in both.
 * `get-provider.preview.test.ts` runs both over the same keys and fails when they disagree.
 */
export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
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
  } = input;

  if (isLocalFakeLlmEnabled() && isLocalFakeDeterministicModel(requestedModel)) {
    const localFakeProvider = getLocalFakeLlmProvider();
    if (localFakeProvider) {
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
    return await resolveCustomLlmProvider(customLlm, user, organizationId, countryCode);
  }

  const directByok = await resolveDirectByokProvider(user, requestedModel, request, organizationId);
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
      return { kind: 'chatgpt-reconnect', message: openAiChatGptByok.message };
    }
    if (!openAiChatGptByok) return null;
    return { ...openAiChatGptByok, isFree: isFreeModelExcludingCustomLlms(requestedModel) };
  };

  const directCandidates = directByok?.candidates ?? [];
  const catalogKeyServes = directCandidates.some(candidate => candidate.decision === 'serves');
  if (!catalogKeyServes) {
    const chatGpt = await checkChatGpt();
    if (chatGpt) return chatGpt;
  }

  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;
  const decideGatewayKey = createGatewayKeyDecider(requestedModel, resolveRoutingProviderConfig);
  const routes = rankByokRoutes(
    directCandidates,
    await getGatewayRoutedByokKeys(user, requestedModel, organizationId, {
      includeGatewayKeys: true,
    })
  );
  for (const route of routes) {
    if (route.route === 'direct-byok') {
      if (route.candidate.decision !== 'serves') continue;
      const { provider, model, key } = route.candidate;
      return directByokProviderResult(provider, model, key, requestedModel, request, true);
    }
    if (route.route === 'gateway-byok' && (await decideGatewayKey(route.providerId)) !== 'serves') {
      continue;
    }
    return (
      (catalogKeyServes ? await checkChatGpt() : null) ??
      gatewayRoutedByokResult(route, requestedModel)
    );
  }

  // BYOK requests are never billed to Kilo, so a catalog id the caller's keys serve, but not over
  // this API kind, fails with the unsupported-API error instead of taking a Kilo route.
  const unsupported = findUnsupportedApiKindCandidate(routes);
  if (unsupported) {
    const { provider, model, key } = unsupported;
    return directByokProviderResult(provider, model, key, requestedModel, request, true);
  }

  const kiloGateway = await selectKiloGateway(requestedModel, boundedSpending, async () =>
    withIgnoredProviders(await resolveRoutingProviderConfig(), kiloIgnoredProviders)
  );
  return {
    kind: 'provider',
    provider: kiloGateway === 'vercel' ? VERCEL_AI_GATEWAY : OPENROUTER,
    userByok: null,
    isFree: isFreeModelExcludingCustomLlms(requestedModel),
    bypassAccessCheck: false,
  };
}

export const GatewayChatApiKindSchema = z.enum([
  'chat_completions',
  'responses',
  'messages',
]) satisfies z.ZodType<GatewayChatApiKind>;

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
 * KEEP IN SYNC WITH `getProvider` above: mirror any change to its step order or key decisions.
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
    keys.filter(key => candidateProviders.includes(key.providerId))
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

  steps.push({
    route: 'kilo',
    outcome: 'used',
    gateway: await selectKiloGateway(requestedModel, false, noProviderRestrictions),
  });
  return { kind: 'routes', steps: markUnreachedSteps(steps) };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; isFree: boolean }> {
  const isFree = isFreeModelExcludingCustomLlms(requestedModel);
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const inference = await getGatewayRoutedByokKeys(user, requestedModel, organizationId, {
    includeGatewayKeys: false,
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
