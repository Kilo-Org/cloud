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
  getBYOKforOrganization,
  getBYOKforUser,
  getModelUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import type {
  BYOKResult,
  GatewayChatApiKind,
  Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  getDirectByokModel,
  getDirectByokSupportedChatApis,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { checkOpenAiChatGptByok } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  CustomLlmCredentialsSchema,
  type CustomLlmCredentials,
  type CustomLlmProvider,
} from '@kilocode/db/schema-types';
import {
  buildDirectProvider,
  type DirectUpstreamAuth,
} from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import { getGoogleServiceAccountAccessToken } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account';
import { userHasCustomLlmAccess } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/access';
import {
  findCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
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
  /** Skip balance, paid-auth, and organization policy checks entirely. Used
   *  by direct-byok and custom_llm2 because both already require explicit
   *  admin opt-in. */
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

async function checkDirectBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<GetProviderProviderResult | null> {
  const { provider: directByok, model: directByokModel } = await getDirectByokModel(requestedModel);
  if (!directByok || !directByokModel) {
    return null;
  }
  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, [directByok.id])
    : await getBYOKforUser(readDb, user.id, [directByok.id]);
  if (!userByok || userByok.length === 0) {
    return null;
  }
  return {
    kind: 'provider',
    provider: {
      id: 'direct-byok',
      apiUrl: directByok.base_url,
      apiUrlOverrides: directByok.base_url_overrides,
      disableUrlSuffix: false,
      apiKey: userByok[0].decryptedAPIKey,
      apiKeyHeader: null,
      supportedChatApis: getDirectByokSupportedChatApis(
        directByok,
        organizationId ? 'organization' : 'user'
      ),
      responseTransforms: directByok.reasoning_details_transform,
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        delete context.request.body.provider;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: true,
  };
}

const CUSTOM_LLM_CHAT_API = {
  anthropic: 'messages',
  openai: 'responses',
  openrouter: 'chat_completions',
  google: 'generate_content',
} as const satisfies Record<CustomLlmProvider, GatewayChatApiKind>;

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
  }
}

/**
 * A custom LLM owns its id: a caller without access, or a definition with
 * unusable credentials, must not fall back to another upstream for the same id.
 */
async function resolveCustomLlmProvider(
  { public_id, definition: customLlm, encrypted_api_key }: CustomLlm,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<GetProviderResult> {
  if (
    isAnonymousContext(user) ||
    !organizationId ||
    !(await userHasCustomLlmAccess(customLlm, organizationId, user.id))
  ) {
    return { kind: 'custom-llm-unavailable' };
  }

  if (!encrypted_api_key) {
    console.error('Custom LLM has no stored credentials', public_id);
    return { kind: 'custom-llm-unavailable' };
  }

  const decrypted = decryptApiKey(encrypted_api_key, BYOK_ENCRYPTION_KEY);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    console.error('Custom LLM credentials are not valid JSON', public_id);
    return { kind: 'custom-llm-unavailable' };
  }
  const parsedCredentials = CustomLlmCredentialsSchema.safeParse(parsedJson);
  if (!parsedCredentials.success) {
    console.error('Custom LLM credentials do not match the schema', public_id);
    return { kind: 'custom-llm-unavailable' };
  }

  return {
    kind: 'provider',
    provider: buildDirectProvider(
      'custom',
      [CUSTOM_LLM_CHAT_API[customLlm.opencode_settings?.ai_sdk_provider ?? 'openrouter']],
      customLlm,
      await resolveCustomLlmAuth(parsedCredentials.data)
    ),
    userByok: null,
    bypassAccessCheck: true,
  };
}

async function checkVercelBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<BYOKResult[] | null> {
  if (isAnonymousContext(user)) return null;
  // Kilo-exclusive models are not routable through Vercel BYOK. Reasoning in particular
  // breaks: the Vercel AI Gateway normalizes reasoning to each provider's upstream-native
  // shape, whereas our Kilo-exclusive models are served through generic OpenAI-compatible
  // endpoints (Martian, direct Alibaba, etc.) where that normalization doesn't apply and the
  // response ends up corrupted. Skip the Vercel BYOK lookup entirely and let the caller fall
  // through to the model's declared gateway.
  if (isKiloExclusiveModel(requestedModel)) return null;
  const modelProviders = await getModelUserByokProviders(requestedModel);
  if (modelProviders.length === 0) return null;
  return organizationId
    ? getBYOKforOrganization(readDb, organizationId, modelProviders)
    : getBYOKforUser(readDb, user.id, modelProviders);
}

export type GetProviderInput = {
  requestedModel: string;
  request: GatewayRequest;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  /** The platform caller for a service run; see `OpenAiChatGptRoutingInput`. */
  botId?: string | undefined;
  /** Resolves organization/group provider policy only when selecting a managed
   * gateway. Direct BYOK and custom LLM routes remain exempt. */
  getRoutingProviderConfig?: () => Promise<OpenRouterProviderConfig | undefined>;
};

export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
  const { requestedModel, request, user, organizationId, botId, getRoutingProviderConfig } = input;

  if (isLocalFakeLlmEnabled() && isLocalFakeDeterministicModel(requestedModel)) {
    const localFakeProvider = getLocalFakeLlmProvider();
    if (localFakeProvider) {
      return {
        kind: 'provider',
        provider: localFakeProvider,
        userByok: null,
        bypassAccessCheck: true,
      };
    }
  }

  const customLlm = await findCustomLlm(requestedModel);
  if (customLlm) {
    return await resolveCustomLlmProvider(customLlm, user, organizationId);
  }

  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
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
    return openAiChatGptByok;
  }

  const vercelByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (vercelByok) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: vercelByok,
      bypassAccessCheck: false,
    };
  }

  const kiloExclusiveModel = findKiloExclusiveModel(requestedModel);

  const eligibleForVercelRouting =
    !kiloExclusiveModel || kiloExclusiveModel.flags.includes('vercel-routing');
  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;

  if (
    eligibleForVercelRouting &&
    (await shouldRouteToVercel(requestedModel, request, resolveRoutingProviderConfig))
  ) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: null,
      bypassAccessCheck: false,
    };
  }

  return {
    kind: 'provider',
    provider: kiloExclusiveModel?.provider ?? OPENROUTER,
    userByok: null,
    bypassAccessCheck: false,
  };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null }> {
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const userByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (userByok) {
    return { provider: VERCEL_AI_GATEWAY, userByok };
  }

  // 2. All non-BYOK embedding requests go through OpenRouter
  return { provider: OPENROUTER, userByok: null };
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
