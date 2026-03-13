import { getEnvVariable } from '@/lib/dotenvx';
import { debugSaveProxyResponseStream } from '../debugUtils';
import { fetchWithBackoff } from '../fetchWithBackoff';
import { captureException, captureMessage } from '@sentry/nextjs';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterGeneration,
} from '@/lib/providers/openrouter/types';
import {
  applyMistralModelSettings,
  applyMistralProviderSettings,
  isMistralModel,
} from '@/lib/providers/mistral';
import { applyXaiModelSettings, isXaiModel } from '@/lib/providers/xai';
import { applyVercelSettings, shouldRouteToVercel } from '@/lib/providers/vercel';
import { kiloFreeModels } from '@/lib/models';
import {
  applyAnthropicModelSettings,
  isAnthropicModel,
  isHaikuModel,
} from '@/lib/providers/anthropic';
import { applyGigaPotatoProviderSettings } from '@/lib/providers/gigapotato';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getModelUserByokProviders,
  type BYOKResult,
} from '@/lib/byok';
import type { CustomLlm } from '@kilocode/db/schema';
import { custom_llm, type User } from '@kilocode/db/schema';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/providers/openrouter/inference-provider-id';
import { applyCoreThinkProviderSettings } from '@/lib/providers/corethink';
import { hasAttemptCompletionTool } from '@/lib/tool-calling';
import { applyGoogleModelSettings, isGeminiModel } from '@/lib/providers/google';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { applyMoonshotProviderSettings, isMoonshotModel } from '@/lib/providers/moonshotai';
import type { AnonymousUserContext } from '@/lib/anonymous';
import { isAnonymousContext } from '@/lib/anonymous';
import { isOpenAiModel } from '@/lib/providers/openai';
import { applyQwenModelSettings, isQwenModel } from '@/lib/providers/qwen';
import type { ProviderId } from '@/lib/providers/provider-id';
import { isZaiModel } from '@/lib/providers/zai';
import { isMinimaxModel } from '@/lib/providers/minimax';

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
  hasGenerationEndpoint: boolean;
};

export const PROVIDERS = {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    hasGenerationEndpoint: true,
  },
  GIGAPOTATO: {
    id: 'gigapotato',
    apiUrl: getEnvVariable('GIGAPOTATO_API_URL'),
    apiKey: getEnvVariable('GIGAPOTATO_API_KEY'),
    hasGenerationEndpoint: false,
  },
  CORETHINK: {
    id: 'corethink',
    apiUrl: 'https://api.corethink.ai/v1/code',
    apiKey: getEnvVariable('CORETHINK_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
    hasGenerationEndpoint: false,
  },
  MORPH: {
    id: 'morph',
    apiUrl: 'https://api.morphllm.com/v1',
    apiKey: getEnvVariable('MORPH_API_KEY'),
    hasGenerationEndpoint: false,
  },
  OPENAI: {
    id: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: getEnvVariable('OPENAI_API_KEY'),
    hasGenerationEndpoint: false,
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    hasGenerationEndpoint: true,
  },
} as const satisfies Record<string, Provider>;

async function checkBYOK(
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
  request: OpenRouterChatCompletionRequest,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  taskId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; customLlm: CustomLlm | null }> {
  const userByokFromByokCheck = await checkBYOK(user, requestedModel, organizationId);
  if (userByokFromByokCheck) {
    return {
      provider: PROVIDERS.VERCEL_AI_GATEWAY,
      userByok: userByokFromByokCheck,
      customLlm: null,
    };
  }

  if (requestedModel.startsWith('kilo-internal/') && organizationId) {
    const [customLlm] = await db
      .select()
      .from(custom_llm)
      .where(eq(custom_llm.public_id, requestedModel));
    if (customLlm && customLlm.organization_ids.includes(organizationId)) {
      return {
        provider: {
          id: 'custom',
          apiUrl: customLlm.base_url,
          apiKey: customLlm.api_key,
          hasGenerationEndpoint: true,
        },
        userByok: null,
        customLlm,
      };
    }
  }

  if (await shouldRouteToVercel(requestedModel, request, taskId || user.id)) {
    return { provider: PROVIDERS.VERCEL_AI_GATEWAY, userByok: null, customLlm: null };
  }

  const kiloFreeModel = kiloFreeModels.find(m => m.public_id === requestedModel);
  const freeModelProvider = Object.values(PROVIDERS).find(p => p.id === kiloFreeModel?.gateway);

  if (kiloFreeModel && freeModelProvider?.id === 'martian') {
    return {
      provider: { ...freeModelProvider, id: 'custom' },
      userByok: null,
      customLlm: {
        public_id: kiloFreeModel.public_id,
        internal_id: kiloFreeModel.internal_id,
        display_name: kiloFreeModel.display_name,
        context_length: kiloFreeModel.context_length,
        max_completion_tokens: kiloFreeModel.max_completion_tokens,
        provider: 'openai', // xai doesn't support preserved reasoning currently: https://github.com/vercel/ai/issues/10542
        organization_ids: [],
        base_url: freeModelProvider.apiUrl,
        api_key: freeModelProvider.apiKey,
        included_tools: null,
        excluded_tools: null,
        supports_image_input: kiloFreeModel.flags.includes('vision'),
        force_reasoning: true,
        opencode_settings: null,
        extra_body: null,
        interleaved_format: null,
      },
    };
  }

  return {
    provider: freeModelProvider ?? PROVIDERS.OPENROUTER,
    userByok: null,
    customLlm: null,
  };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null }> {
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const userByok = await checkBYOK(user, requestedModel, organizationId);
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
  if (isZaiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum['z-ai']];
  }
  return [];
}

function applyPreferredProvider(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
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
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
) {
  const kiloFreeModel = kiloFreeModels.find(m => m.public_id === requestedModel);
  if (kiloFreeModel) {
    requestToMutate.model = kiloFreeModel.internal_id;
    if (kiloFreeModel.inference_provider) {
      if (requestToMutate.provider) {
        requestToMutate.provider.only = [kiloFreeModel.inference_provider];
      } else {
        requestToMutate.provider = { only: [kiloFreeModel.inference_provider] };
      }
    }
  }

  if (isAnthropicModel(requestedModel)) {
    applyAnthropicModelSettings(requestedModel, requestToMutate, extraHeaders);
  }

  applyToolChoiceSetting(requestedModel, requestToMutate);

  applyPreferredProvider(requestedModel, requestToMutate);

  if (isXaiModel(requestedModel)) {
    applyXaiModelSettings(requestedModel, requestToMutate, extraHeaders);
  }

  if (isGeminiModel(requestedModel)) {
    applyGoogleModelSettings(provider.id, requestToMutate);
  }

  if (isMoonshotModel(requestedModel)) {
    applyMoonshotProviderSettings(requestToMutate);
  }

  if (isQwenModel(requestedModel)) {
    applyQwenModelSettings(requestToMutate);
  }

  if (provider.id === 'gigapotato') {
    applyGigaPotatoProviderSettings(requestedModel, requestToMutate);
  }

  if (provider.id === 'corethink') {
    applyCoreThinkProviderSettings(requestToMutate);
  }

  if (provider.id === 'mistral') {
    applyMistralProviderSettings(requestToMutate, extraHeaders);
  } else if (isMistralModel(requestedModel)) {
    applyMistralModelSettings(requestToMutate);
  }

  if (provider.id === 'vercel') {
    applyVercelSettings(requestedModel, requestToMutate, extraHeaders, userByok);
  }
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
  body: OpenRouterChatCompletionRequest;
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
