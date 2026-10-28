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
  isGatewayUserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { withIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  byokOwner,
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  isGatewayUserByokEligibleModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  createUserOpenRouterProvider,
  OPENROUTER,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import {
  createUserVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { getDirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { checkOpenAiChatGptByok } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
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
   *  by direct-byok and non-public custom_llm2 because both already require
   *  explicit admin opt-in. */
  bypassAccessCheck: boolean;
  /** Skip only the zero-balance paid-model block. Set when a user credential
   *  outside Kilo credits pays for the request, such as the ChatGPT
   *  subscription, while abuse and organization policy checks still apply. */
  skipBalanceCheck?: boolean;
};

export type GetProviderResult =
  | GetProviderProviderResult
  | { kind: 'chatgpt-reconnect'; message: string }
  /** The id is a custom LLM the caller may not use, or its stored credentials are unusable. */
  | { kind: 'custom-llm-unavailable' };

/**
 * Direct BYOK model IDs name their provider, such as `neuralwatt/...`, and the
 * request goes straight to that provider with the stored key, bypassing Kilo's
 * gateways.
 */
async function resolveDirectByokProvider(
  user: User | AnonymousUserContext,
  requestedModel: string,
  request: GatewayRequest,
  organizationId: string | undefined
): Promise<GetProviderProviderResult | null> {
  const { provider: directByok, model: directByokModel } = await getDirectByokModel(requestedModel);
  if (!directByok || !directByokModel) {
    return null;
  }
  const [credential] = await getByokCredentials(readDb, byokOwner(user.id, organizationId), [
    directByok.id,
  ]);
  if (!credential) {
    return null;
  }

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
    bypassAccessCheck: true,
  };
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

type GatewayRoutedByok = {
  /** Inference provider keys, sent through Kilo's Vercel AI Gateway account. */
  inference: BYOKResult[];
  /** Whole-gateway keys that replace Kilo's own gateway key. */
  gateway: BYOKResult[];
};

/**
 * Stored keys that can serve a catalog model through a gateway, unlike direct
 * BYOK, where the model ID itself names the provider.
 */
async function getGatewayRoutedByok(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined,
  { includeGatewayKeys }: { includeGatewayKeys: boolean }
): Promise<GatewayRoutedByok> {
  const none: GatewayRoutedByok = { inference: [], gateway: [] };
  if (isAnonymousContext(user)) return none;
  // Kilo-exclusive models stay on Kilo's own accounts, like in `getModelGatewayUserByokProviders`.
  if (isKiloExclusiveModel(requestedModel)) return none;
  const candidateProviders = [
    ...(await getModelInferenceUserByokProviders(requestedModel)),
    ...(includeGatewayKeys && isGatewayUserByokEligibleModel(requestedModel)
      ? GatewayUserByokProviderIdSchema.options
      : []),
  ];
  if (candidateProviders.length === 0) return none;
  const userByok =
    (organizationId
      ? await getBYOKforOrganization(readDb, organizationId, candidateProviders)
      : await getBYOKforUser(readDb, user.id, candidateProviders)) ?? [];
  const inference = userByok.filter(byok => !isGatewayUserByokProviderId(byok.providerId));
  const gatewayKeys = userByok.filter(byok => isGatewayUserByokProviderId(byok.providerId));
  // Inference provider keys take priority, so gateway keys then go unused.
  if (inference.length > 0 || gatewayKeys.length === 0) return { inference, gateway: [] };
  const gatewayProviders: readonly string[] =
    await getModelGatewayUserByokProviders(requestedModel);
  return {
    inference,
    gateway: gatewayKeys.filter(byok => gatewayProviders.includes(byok.providerId)),
  };
}

/**
 * Prefers the Vercel AI Gateway key when Vercel can serve the model under the
 * provider routing settings, and the OpenRouter key otherwise.
 */
async function checkGatewayBYOK(
  gatewayByok: BYOKResult[],
  requestedModel: string,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
): Promise<GetProviderProviderResult | null> {
  const vercelKey = gatewayByok.find(byok => byok.providerId === 'vercel-ai-gateway');
  if (vercelKey && (await canRouteToVercel(requestedModel, getRoutingProviderConfig))) {
    return {
      kind: 'provider',
      provider: createUserVercelAiGatewayProvider(vercelKey.decryptedAPIKey),
      userByok: [vercelKey],
      isFree: isFreeModelExcludingCustomLlms(requestedModel),
      bypassAccessCheck: false,
    };
  }
  const openRouterKey = gatewayByok.find(byok => byok.providerId === 'openrouter');
  if (openRouterKey) {
    return {
      kind: 'provider',
      provider: createUserOpenRouterProvider(openRouterKey.decryptedAPIKey),
      userByok: [openRouterKey],
      isFree: isFreeModelExcludingCustomLlms(requestedModel),
      bypassAccessCheck: false,
    };
  }
  return null;
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

  const directByokProvider = await resolveDirectByokProvider(
    user,
    requestedModel,
    request,
    organizationId
  );
  if (directByokProvider) {
    return directByokProvider;
  }

  // An enabled "Sign in with ChatGPT" connection wins for an eligible OpenAI
  // responses request, before the Vercel BYOK lookup. A connection whose
  // credential is terminally dead must fail readably instead of resolving to
  // another billing path. Every other resolution (including an ineligible
  // request for the same model) stays as it is today.
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
  if (openAiChatGptByok) {
    return {
      ...openAiChatGptByok,
      isFree: isFreeModelExcludingCustomLlms(requestedModel),
    };
  }

  const gatewayRoutedByok = await getGatewayRoutedByok(user, requestedModel, organizationId, {
    includeGatewayKeys: true,
  });
  if (gatewayRoutedByok.inference.length > 0) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: gatewayRoutedByok.inference,
      isFree: isFreeModelExcludingCustomLlms(requestedModel),
      bypassAccessCheck: false,
    };
  }

  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;

  const gatewayByok = await checkGatewayBYOK(
    gatewayRoutedByok.gateway,
    requestedModel,
    resolveRoutingProviderConfig
  );
  if (gatewayByok) {
    return gatewayByok;
  }

  if (
    !boundedSpending &&
    (await shouldRouteToVercel(requestedModel, request, async () =>
      withIgnoredProviders(await resolveRoutingProviderConfig(), kiloIgnoredProviders)
    ))
  ) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: null,
      isFree: isFreeModelExcludingCustomLlms(requestedModel),
      bypassAccessCheck: false,
    };
  }

  return {
    kind: 'provider',
    provider: OPENROUTER,
    userByok: null,
    isFree: isFreeModelExcludingCustomLlms(requestedModel),
    bypassAccessCheck: false,
  };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; isFree: boolean }> {
  const isFree = isFreeModelExcludingCustomLlms(requestedModel);
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const { inference } = await getGatewayRoutedByok(user, requestedModel, organizationId, {
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
