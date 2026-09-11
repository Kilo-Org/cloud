import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import { findKiloExclusiveModel, isKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getModelUserByokProviders,
} from '@/lib/ai-gateway/byok';
import { custom_llm2, type User } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import type { AnonymousUserContext } from '@/lib/anonymous';
import { isAnonymousContext } from '@/lib/anonymous';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { tryGetProviderById } from '@/lib/ai-gateway/providers/definitions/try-get-provider-by-id';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/definitions/vercel';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import { CustomLlmCredentialsSchema, CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import { buildDirectProvider } from '@/lib/ai-gateway/providers/build-direct-provider';
import { getGoogleServiceAccountAccessToken } from '@/lib/ai-gateway/custom-llm/google-service-account';
import { userHasCustomLlmAccess } from '@/lib/ai-gateway/custom-llm/access';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  getLocalFakeLlmProvider,
  getLocalFakeTranscriptionProvider,
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
} from '@/lib/ai-gateway/local-fake-llm';

export type GetProviderProviderResult = {
  kind: 'provider';
  provider: Provider;
  userByok: BYOKResult[] | null;
  /** Skip balance, paid-auth, and organization policy checks entirely. Used
   *  by direct-byok and custom_llm2 because both already require explicit
   *  admin opt-in. */
  bypassAccessCheck: boolean;
};

export type GetProviderResult = GetProviderProviderResult;

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
      apiKey: userByok[0].decryptedAPIKey,
      apiKeyHeader: null,
      supportedChatApis: directByok.supported_chat_apis,
      responseTransforms: null,
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: true,
  };
}

async function checkCustomLlm(
  requestedModel: string,
  organizationId: string,
  kiloUserId: string
): Promise<GetProviderProviderResult | null> {
  const [row] = await readDb
    .select()
    .from(custom_llm2)
    .where(eq(custom_llm2.public_id, requestedModel));
  const parsedCustomLlm = CustomLlmDefinitionSchema.safeParse(row?.definition);
  if (row && !parsedCustomLlm.success) {
    console.log('Failed to parse custom llm definition', parsedCustomLlm.error);
  }
  const customLlm = parsedCustomLlm.data;
  if (!customLlm || !(await userHasCustomLlmAccess(customLlm, organizationId, kiloUserId))) {
    return null;
  }

  if (!row?.encrypted_api_key) {
    return null;
  }

  const decrypted = decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return null;
  }
  const parsedCredentials = CustomLlmCredentialsSchema.safeParse(parsedJson);
  if (!parsedCredentials.success) {
    return null;
  }

  let apiKey: string;
  let apiKeyHeader: 'x-api-key' | null = null;
  if (parsedCredentials.data.type === 'api_key' || parsedCredentials.data.type === 'x-api-key') {
    apiKey = parsedCredentials.data.api_key;
    apiKeyHeader = parsedCredentials.data.type === 'x-api-key' ? 'x-api-key' : null;
  } else {
    apiKey = await getGoogleServiceAccountAccessToken(parsedCredentials.data);
  }

  const resolvedCustomLlm = {
    ...customLlm,
    api_key: apiKey,
  };
  return {
    kind: 'provider',
    provider: buildDirectProvider(
      'custom',
      [
        customLlm.opencode_settings?.ai_sdk_provider === 'anthropic'
          ? 'messages'
          : customLlm.opencode_settings?.ai_sdk_provider === 'openai'
            ? 'responses'
            : 'chat_completions',
      ],
      resolvedCustomLlm,
      apiKeyHeader
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
  taskId: string | undefined;
  /** Resolves organization/group provider policy only when selecting a managed
   * gateway. Direct BYOK and custom LLM routes remain exempt. */
  getRoutingProviderConfig?: () => Promise<OpenRouterProviderConfig | undefined>;
};

export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
  const { requestedModel, request, user, organizationId, taskId, getRoutingProviderConfig } = input;

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

  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
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

  if (requestedModel.startsWith(CUSTOM_LLM_PREFIX) && organizationId && !isAnonymousContext(user)) {
    const customLlmResult = await checkCustomLlm(requestedModel, organizationId, user.id);
    if (customLlmResult) {
      return customLlmResult;
    }
  }

  const eligibleForVercelRouting =
    !kiloExclusiveModel || kiloExclusiveModel.flags.includes('vercel-routing');
  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;

  if (
    eligibleForVercelRouting &&
    (await shouldRouteToVercel(
      requestedModel,
      request,
      taskId || user.id,
      resolveRoutingProviderConfig
    ))
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
    provider: (kiloExclusiveModel && tryGetProviderById(kiloExclusiveModel.gateway)) ?? OPENROUTER,
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
