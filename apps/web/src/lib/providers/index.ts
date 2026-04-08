import { debugSaveProxyResponseStream } from '../debugUtils';
import { fetchWithBackoff } from '../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
  GatewayRequest,
  GatewayMessagesRequest,
} from '@/lib/providers/openrouter/types';
import { applyMistralModelSettings, isMistralModel } from '@/lib/providers/mistral';
import { applyXaiModelSettings, isXaiModel } from '@/lib/providers/xai';
import { shouldRouteToVercel } from '@/lib/providers/vercel';
import { kiloExclusiveModels } from '@/lib/models';
import {
  applyAnthropicModelSettings,
  isAnthropicModel,
  isHaikuModel,
} from '@/lib/providers/anthropic';
import { getBYOKforOrganization, getBYOKforUser, getModelUserByokProviders } from '@/lib/byok';
import { custom_llm2, type User } from '@kilocode/db/schema';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/providers/openrouter/inference-provider-id';
import { hasAttemptCompletionTool } from '@/lib/tool-calling';
import { applyGoogleModelSettings, isGeminiModel } from '@/lib/providers/google';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { applyMoonshotModelSettings, isMoonshotModel } from '@/lib/providers/moonshotai';
import type { AnonymousUserContext } from '@/lib/anonymous';
import { isAnonymousContext } from '@/lib/anonymous';
import { isOpenAiModel, isOpenAiOssModel } from '@/lib/providers/openai';
import { isZaiModel } from '@/lib/providers/zai';
import { isMinimaxModel } from '@/lib/providers/minimax';
import { isXiaomiModel } from '@/lib/providers/xiaomi';
import type { BYOKResult, Provider } from '@/lib/providers/types';
import PROVIDERS from '@/lib/providers/provider-definitions';
import { getDirectByokModel } from '@/lib/providers/direct-byok';
import { CustomLlmDefinitionSchema, type CustomLlmProvider } from '@kilocode/db';
import { addCacheBreakpoints } from '@/lib/providers/openrouter/request-helpers';

function inferSupportedChatApis(aiSdkProvider: CustomLlmProvider) {
  return aiSdkProvider === 'anthropic'
    ? (['messages'] as const)
    : aiSdkProvider === 'openai'
      ? (['responses'] as const)
      : (['chat_completions'] as const);
}

async function checkDirectBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
) {
  const { provider: directByok, model: directByokModel } = getDirectByokModel(requestedModel);
  if (!directByok || !directByokModel) {
    return null;
  }
  const userByok = organizationId
    ? await getBYOKforOrganization(db, organizationId, [directByok.id])
    : await getBYOKforUser(db, user.id, [directByok.id]);
  if (!userByok || userByok.length === 0) {
    return null;
  }
  return {
    provider: {
      id: 'direct-byok',
      apiUrl: directByok.base_url,
      apiKey: userByok[0].decryptedAPIKey,
      supportedChatApis: inferSupportedChatApis(directByok.ai_sdk_provider),
      transformRequest(context) {
        context.request.body.model = directByokModel.id;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: false,
  };
}

async function checkVercelBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<BYOKResult[] | null> {
  if (isAnonymousContext(user)) return null;
  const modelProviders = await getModelUserByokProviders(requestedModel);
  if (modelProviders.length === 0) return null;
  return organizationId
    ? getBYOKforOrganization(db, organizationId, modelProviders)
    : getBYOKforUser(db, user.id, modelProviders);
}

export async function getProvider(
  requestedModel: string,
  request: GatewayRequest,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  taskId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; bypassAccessCheck: boolean }> {
  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
  }

  const vercelByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (vercelByok) {
    return {
      provider: PROVIDERS.VERCEL_AI_GATEWAY,
      userByok: vercelByok,
      bypassAccessCheck: false,
    };
  }

  if (requestedModel.startsWith('kilo-internal/') && organizationId) {
    const [row] = await db
      .select()
      .from(custom_llm2)
      .where(eq(custom_llm2.public_id, requestedModel));
    const parsedCustomLlm = CustomLlmDefinitionSchema.safeParse(row?.definition);
    if (row && !parsedCustomLlm.success) {
      console.log('Failed to parse custom llm definition', parsedCustomLlm.error);
    }
    const customLlm = parsedCustomLlm.data;
    if (customLlm && customLlm.organization_ids.includes(organizationId)) {
      return {
        provider: {
          id: 'custom',
          apiUrl: customLlm.base_url,
          apiKey: customLlm.api_key,
          supportedChatApis: inferSupportedChatApis(
            customLlm.opencode_settings?.ai_sdk_provider ?? 'openrouter'
          ),
          transformRequest(context) {
            if (customLlm.remove_from_body) {
              const body = context.request.body as Record<string, unknown>;
              for (const key of customLlm.remove_from_body ?? []) {
                delete body[key];
              }
            }
            Object.assign(context.request.body, customLlm.extra_body ?? {});
            Object.assign(context.extraHeaders, customLlm.extra_headers ?? {});
            context.request.body.model = customLlm.internal_id;
            if (customLlm.add_cache_breakpoints) {
              addCacheBreakpoints(context.request);
            }
            if (
              customLlm.reasoning_summary &&
              context.request.kind === 'responses' &&
              context.request.body.reasoning
            ) {
              context.request.body.reasoning.summary = customLlm.reasoning_summary;
            }
          },
        },
        userByok: null,
        bypassAccessCheck: true,
      };
    }
  }

  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  const defaultProvider =
    Object.values(PROVIDERS).find(p => p.id === kiloExclusiveModel?.gateway) ??
    PROVIDERS.OPENROUTER;

  if (
    defaultProvider.id === 'openrouter' &&
    (await shouldRouteToVercel(requestedModel, request, taskId || user.id))
  ) {
    return { provider: PROVIDERS.VERCEL_AI_GATEWAY, userByok: null, bypassAccessCheck: false };
  }

  return {
    provider: defaultProvider,
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
    return { provider: PROVIDERS.VERCEL_AI_GATEWAY, userByok };
  }

  // 2. All non-BYOK embedding requests go through OpenRouter
  return { provider: PROVIDERS.OPENROUTER, userByok: null };
}

function applyToolChoiceSetting(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (!hasAttemptCompletionTool(requestToMutate)) {
    return;
  }
  const isReasoningEnabled =
    (requestToMutate.reasoning?.enabled ?? false) === true ||
    (requestToMutate.reasoning?.effort ?? 'none') !== 'none' ||
    (requestToMutate.reasoning?.max_tokens ?? 0) > 0;
  if (
    isXaiModel(requestedModel) ||
    isOpenAiModel(requestedModel) ||
    isGeminiModel(requestedModel) ||
    (isHaikuModel(requestedModel) && !isReasoningEnabled)
  ) {
    console.debug('[applyToolChoiceSetting] setting tool_choice required');
    requestToMutate.tool_choice = 'required';
  }
}

function getPreferredProviderOrder(requestedModel: string): string[] {
  if (isAnthropicModel(requestedModel)) {
    // Use `order` (set below in applyPreferredProvider) to preferentially
    // route Anthropic models to Bedrock and Anthropic. Google Vertex doesn't
    // support assistant message prefill, which causes 400 errors on tool
    // calls when OpenRouter falls back to it.
    return [
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
      OpenRouterInferenceProviderIdSchema.enum.anthropic,
    ];
  }
  if (isMinimaxModel(requestedModel)) {
    return ['minimax/fp8']; // do not prefer minimax/highspeed
  }
  if (isMistralModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.mistral];
  }
  if (isMoonshotModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.moonshotai];
  }
  if (isXiaomiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum['xiaomi']];
  }
  if (isZaiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum['z-ai']];
  }
  if (isOpenAiOssModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum.novita,
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
    ];
  }
  return [];
}

function applyPreferredProvider(
  requestedModel: string,
  requestToMutate:
    | OpenRouterChatCompletionRequest
    | GatewayResponsesRequest
    | GatewayMessagesRequest
) {
  const preferredProviderOrder = getPreferredProviderOrder(requestedModel);
  if (preferredProviderOrder.length === 0) {
    return;
  }
  console.debug(
    `[applyPreferredProvider] Preferentially routing ${requestedModel} to ${preferredProviderOrder.join()}`
  );
  if (!requestToMutate.provider) {
    requestToMutate.provider = { order: preferredProviderOrder };
  } else if (!requestToMutate.provider.order) {
    requestToMutate.provider.order = preferredProviderOrder;
  }
}

export function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
) {
  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  if (kiloExclusiveModel) {
    requestToMutate.body.model = kiloExclusiveModel.internal_id;
    if (kiloExclusiveModel.inference_provider) {
      if (requestToMutate.body.provider) {
        requestToMutate.body.provider.only = [kiloExclusiveModel.inference_provider];
      } else {
        requestToMutate.body.provider = { only: [kiloExclusiveModel.inference_provider] };
      }
    }
  }

  if (isAnthropicModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (requestToMutate.kind === 'chat_completions') {
    applyToolChoiceSetting(requestedModel, requestToMutate.body);
  }

  applyPreferredProvider(requestedModel, requestToMutate.body);

  if (isXaiModel(requestedModel)) {
    applyXaiModelSettings(requestToMutate, extraHeaders);
  }

  if (isGeminiModel(requestedModel)) {
    applyGoogleModelSettings(provider.id, requestToMutate);
  }

  if (isMoonshotModel(requestedModel)) {
    applyMoonshotModelSettings(requestToMutate);
  }

  if (isMistralModel(requestedModel)) {
    applyMistralModelSettings(requestToMutate);
  }

  provider.transformRequest({
    model: requestedModel,
    request: requestToMutate,
    extraHeaders,
    userByok,
  });
}

export async function openRouterRequest({
  path,
  search,
  method,
  body,
  extraHeaders,
  provider,
  signal,
}: {
  path: string;
  search: string;
  method: string;
  body: OpenRouterChatCompletionRequest | GatewayResponsesRequest | GatewayMessagesRequest;
  extraHeaders: Record<string, string>;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const headers = new Headers();
  // HTTP-Referer deviates from HTTP spec per https://openrouter.ai/docs/api-reference/overview#headers
  // Important: this must be the same as in the extension, so they're seen as the same app.
  // TODO: Don't change HTTP-Referer; per OpenRouter docs it would identify us as a different app
  headers.set('HTTP-Referer', 'https://kilocode.ai');
  headers.set('X-Title', 'Kilo Code');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  headers.set('Content-Type', 'application/json');

  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const targetUrl = `${provider.apiUrl}${path}${search}`;

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return await fetch(targetUrl, {
    method,
    headers,
    body: JSON.stringify(body),
    // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
    duplex: 'half',
    signal: combinedSignal,
  });
}
export async function fetchGeneration(messageId: string, provider: Provider) {
  // We have to delay, openrouter doesn't have the cost immediately
  await new Promise(res => setTimeout(res, 200));
  //ref: https://openrouter.ai/docs/api-reference/get-a-generation
  let response: Response;
  try {
    response = await fetchWithBackoff(
      `${provider.apiUrl}/generation?id=${messageId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'HTTP-Referer': 'https://kilocode.ai',
          'X-Title': 'Kilo Code',
        },
      },
      { retryResponse: r => r.status >= 400 } // openrouter returns 404 when called too soon.
    );
  } catch (error) {
    captureException(error, {
      level: 'info',
      tags: { source: `${provider.id}_generation_fetch` },
      extra: { messageId },
    });
    return;
  }

  if (!response.ok) {
    const responseText = await response.text();
    captureMessage(`Timed out fetching openrouter generation`, {
      level: 'info',
      tags: { source: `${provider.id}_generation_fetch` },
      extra: {
        messageId,
        status: response.status,
        statusText: response.statusText,
        responseText,
      },
    });
    return;
  }

  debugSaveProxyResponseStream(response, `-${messageId}.log.generation.json`);

  return (await response.json()) as OpenRouterGeneration;
}
