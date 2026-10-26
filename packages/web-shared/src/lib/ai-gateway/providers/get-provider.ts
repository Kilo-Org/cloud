import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { shouldRouteToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  findKiloExclusiveModel,
  isKiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  byokOwner,
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getModelUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  findDirectByokCatalogModels,
  getDirectByokCatalogModelId,
  getDirectByokModel,
  supportsCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
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
): Promise<GetProviderProviderResult | DirectByokCatalogOnlyResult | null> {
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
  const credentials = await getByokCredentials(
    readDb,
    owner,
    catalogModels.map(({ provider }) => provider.id)
  );
  for (const { provider, model } of catalogModels) {
    const credential = credentials.find(
      candidate => candidate.providerId === provider.id && candidate.serveCatalogModels
    );
    if (credential) {
      return directByokProviderResult(provider, model, credential, requestedModel, request, true);
    }
  }
  return null;
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
};

/**
 * Stored keys that can serve a catalog model through a gateway, unlike direct
 * BYOK, where the model ID itself names the provider.
 */
async function getGatewayRoutedByok(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<GatewayRoutedByok> {
  if (isAnonymousContext(user)) return { inference: [] };
  // Kilo-exclusive models are not routable through Vercel BYOK. Reasoning in particular
  // breaks: the Vercel AI Gateway normalizes reasoning to each provider's upstream-native
  // shape, whereas our Kilo-exclusive models are served through generic OpenAI-compatible
  // endpoints (Martian, direct Alibaba, etc.) where that normalization doesn't apply and the
  // response ends up corrupted. Skip the Vercel BYOK lookup entirely and let the caller fall
  // through to the model's declared gateway.
  if (isKiloExclusiveModel(requestedModel)) return { inference: [] };
  const modelProviders = await getModelUserByokProviders(requestedModel);
  if (modelProviders.length === 0) return { inference: [] };
  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, modelProviders)
    : await getBYOKforUser(readDb, user.id, modelProviders);
  return { inference: userByok ?? [] };
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

  const gatewayRoutedByok = await getGatewayRoutedByok(user, requestedModel, organizationId);
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

  const kiloExclusiveModel = findKiloExclusiveModel(requestedModel);

  const eligibleForVercelRouting =
    !kiloExclusiveModel || kiloExclusiveModel.flags.includes('vercel-routing');

  if (
    eligibleForVercelRouting &&
    !boundedSpending &&
    (await shouldRouteToVercel(requestedModel, request, resolveRoutingProviderConfig))
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
    provider: kiloExclusiveModel?.provider ?? OPENROUTER,
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
  const { inference } = await getGatewayRoutedByok(user, requestedModel, organizationId);
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
