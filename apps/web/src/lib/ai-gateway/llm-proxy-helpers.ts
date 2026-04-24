import { after, NextResponse, type NextRequest } from 'next/server';
import { FEATURE_HEADER, type FeatureValue } from '@/lib/feature-detection';
import { countAndStoreUsage, logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import { startInactiveSpan, captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL, FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { type User } from '@kilocode/db/schema';
import { errorExceptInTest, warnExceptInTest } from '@/lib/utils.server';

import type { Span } from '@sentry/nextjs';
import { debugSaveProxyResponseStream } from '@/lib/debugUtils';
import type {
  OrganizationSettings,
  OrganizationPlan,
} from '@/lib/organizations/organization-types';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
  GatewayRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import {
  type FraudDetectionHeaders,
  getFraudDetectionHeaders,
  isRooCodeBasedClient,
  toMicrodollars,
} from '@/lib/utils';
import { normalizeProjectId } from '@/lib/normalizeProjectId';
import { getXKiloCodeVersionNumber } from '@/lib/userAgent';
import { normalizeModelId } from '@/lib/ai-gateway/providers/openrouter';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { sentryRootSpan } from '../getRootSpan';
import { isKiloStealthModel, kiloExclusiveModels } from '@/lib/ai-gateway/models';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  PromptInfo,
} from '@/lib/ai-gateway/processUsage.types';
import { detectContextOverflow } from '@/lib/ai-gateway/context-overflow';
import { KILO_AUTO_BALANCED_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto';
import type { GatewayChatApiKind, ProviderId } from '@/lib/ai-gateway/providers/types';
export { proxyErrorTypeSchema, ProxyErrorType } from '@/lib/proxy-error-types';
import { ProxyErrorType } from '@/lib/proxy-error-types';

// FIM suffix markers for tracking purposes - used to wrap suffix in a fake system prompt format
// This allows FIM requests to be tracked consistently with chat requests
const fimSuffixFakeSysPrompMarkers = { begin: '[FIM_SUFFIX:', end: ']' } as const;

export function invalidPathResponse() {
  return NextResponse.json(
    {
      error: 'Invalid path',
      error_type: ProxyErrorType.invalid_path,
      message: 'This endpoint only accepts the path `/chat/completions`.',
    },
    { status: 400 }
  );
}

export function invalidRequestResponse() {
  return NextResponse.json(
    {
      error: 'Invalid request',
      error_type: ProxyErrorType.invalid_request,
      message: 'Could not parse request body. Please ensure it is valid JSON.',
    },
    { status: 400 }
  );
}

export function temporarilyUnavailableResponse() {
  return NextResponse.json(
    {
      error: 'Service Unavailable',
      error_type: ProxyErrorType.temporarily_unavailable,
      message: 'The service is temporarily unavailable. Please try again later.',
    },
    { status: 503 }
  );
}

export function upgradeRequiredResponse() {
  return NextResponse.json(
    {
      error: 'upgrade_required',
      error_type: ProxyErrorType.upgrade_required,
      message: 'Please upgrade your Kilo extension to the latest version.',
    },
    { status: 426 }
  );
}

export async function usageLimitExceededResponse(user: User, balance?: number) {
  const payments = await summarizeUserPayments(user.id);

  const title = !payments.payments_count ? 'Paid Model - Credits Required' : 'Low Credit Warning!';

  const message =
    !payments.payments_count && FIRST_TOPUP_BONUS_AMOUNT > 0
      ? `This is a paid model. To use paid models, you need to add credits. Get $${FIRST_TOPUP_BONUS_AMOUNT} free on your first topup!`
      : 'Add credits to continue, or switch to a free model';

  return NextResponse.json(
    {
      error: {
        // https://github.com/Kilo-Org/kilocode/blob/d34b562041b5ef823d9f6b4bd96448750576b340/src/core/task/Task.ts#L2868
        title,
        message,
        balance,
        buyCreditsUrl: APP_URL + '/profile',
      },
      error_type: ProxyErrorType.usage_limit_exceeded,
    },
    { status: 402 }
  );
}

export function dataCollectionRequiredResponse() {
  const error =
    'Data collection is required for this model. Please enable data collection to use this model or choose another model.';
  return NextResponse.json(
    {
      error: error, // this field is shown in the extension
      error_type: ProxyErrorType.data_collection_required,
      message: error,
    },
    { status: 400 }
  );
}

export function apiKindNotSupportedResponse(
  apiKind: GatewayChatApiKind,
  supportedApiKinds: ReadonlyArray<GatewayChatApiKind>,
  fraudHeaders: FraudDetectionHeaders
) {
  const error = isRooCodeBasedClient(fraudHeaders)
    ? 'This model requires Kilo v7 or newer. Please upgrade Kilo and try again.'
    : `This model does not support the ${apiKind} API, please use any of: ${supportedApiKinds.join()}`;
  return NextResponse.json(
    { error, error_type: ProxyErrorType.api_kind_not_supported, message: error },
    { status: 400 }
  );
}

async function stealthModelError(response: Response) {
  const error = 'Stealth model unable to process request';
  warnExceptInTest(`Responding with ${response.status} ${error}`);
  return NextResponse.json(
    { error, error_type: ProxyErrorType.stealth_model_error, message: error },
    { status: response.status }
  );
}

const byokErrorMessages: Record<number, string> = {
  401: '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.',
  402: '[BYOK] Your API account has insufficient funds. Please check your billing details with your API provider.',
  403: '[BYOK] Your API key does not have permission to access this resource. Please check your API key permissions.',
  429: '[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.',
};

function byokErrorMessage(status: number): string | undefined {
  return byokErrorMessages[status];
}

export async function makeErrorReadable({
  requestedModel,
  request,
  response,
  isUserByok,
}: {
  requestedModel: string;
  request: GatewayRequest;
  response: Response;
  isUserByok: boolean;
}) {
  if (response.status < 400) {
    return undefined;
  }

  if (isUserByok) {
    const byokMessage = byokErrorMessage(response.status);
    if (byokMessage) {
      warnExceptInTest(`Responding with ${response.status} ${byokMessage}`);
      return NextResponse.json(
        {
          error: byokMessage,
          error_type: ProxyErrorType.byok_error,
          message: byokMessage,
        },
        { status: response.status }
      );
    }
  }

  const overflowResponse = await detectContextOverflow({ requestedModel, request, response });
  if (overflowResponse) return overflowResponse;

  if (isKiloStealthModel(requestedModel)) {
    return await stealthModelError(response);
  }

  return undefined;
}

export function modelNotAllowedResponse() {
  return NextResponse.json(
    {
      error: 'Model not allowed for your team.',
      error_type: ProxyErrorType.model_not_allowed,
      message: 'The requested model is not allowed for your team.',
    },
    { status: 404 }
  );
}

export function forbiddenFreeModelResponse(header: FraudDetectionHeaders) {
  const errorType = ProxyErrorType.discontinued_free_model;
  if (isRooCodeBasedClient(header)) {
    // https://github.com/Kilo-Org/kilocode/blob/50d6bd482bec6fae7d1c80b14ffb064de3761507/src/shared/kilocode/errorUtils.ts#L13
    const error = `The alpha period for this model has ended.`;
    return NextResponse.json(
      { error: error, error_type: errorType, message: error },
      { status: 404 }
    );
  } else {
    const error = `The free period of this model ended. Please use ${KILO_AUTO_BALANCED_MODEL.id} for affordable inference or ${KILO_AUTO_FREE_MODEL.id} for limited free inference.`;
    return NextResponse.json({ error, error_type: errorType, message: error }, { status: 404 });
  }
}

export function modelDoesNotExistResponse() {
  return NextResponse.json(
    {
      error: 'Model not found',
      error_type: ProxyErrorType.model_not_found,
      message: 'The requested model could not be found.',
    },
    { status: 404 }
  );
}

export function featureExclusiveModelResponse(modelId: string) {
  const exclusiveTo = kiloExclusiveModels.find(m => m.public_id === modelId)?.exclusive_to ?? [];
  const error = `${modelId} is only available for ${exclusiveTo.join(', ')}. Use ${KILO_AUTO_FREE_MODEL.id} as a free alternative.`;
  return NextResponse.json(
    { error, error_type: ProxyErrorType.feature_exclusive_model, message: error },
    { status: 403 }
  );
}

export function storeAndPreviousResponseIdIsNotSupported() {
  const error = 'The store and previous_response_id fields are not supported.';
  return NextResponse.json(
    { error, error_type: ProxyErrorType.unsupported_field, message: error },
    { status: 400 }
  );
}

export function getOutputHeaders(response: Response) {
  const outputHeaders = new Headers();

  for (const headerKey of ['date', 'content-type', 'request-id']) {
    const value = response.headers.get(headerKey);
    if (value) outputHeaders.set(headerKey, value);
  }
  outputHeaders.set('Content-Encoding', 'identity');
  // Content-Encoding: identity is here because Vercel modifies encoding/compression and causes issues

  return outputHeaders;
}

export function wrapInSafeNextResponse(response: Response) {
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getOutputHeaders(response),
  });
}

export function accountForMicrodollarUsage(
  clonedReponse: Response,
  usageContext: MicrodollarUsageContext,
  openrouterRequestSpan: Span | undefined
) {
  const logFileExtension = usageContext.isStreaming ? '.log.resp.sse' : '.log.resp.json';
  debugSaveProxyResponseStream(clonedReponse, logFileExtension);
  after(countAndStoreUsage(clonedReponse, usageContext, openrouterRequestSpan));
}

export async function captureProxyError(params: {
  errorMessage: string;
  user: { id: string };
  request: unknown;
  response: Response;
  organizationId: string | undefined;
  model: string;
  trackInSentry: boolean;
}) {
  const { errorMessage, user, response, organizationId, model, trackInSentry } = params;
  after(
    (async () => {
      const extraErrorData: Record<string, string | number> = {
        kiloUserId: user.id,
        model,
        status: response.status,
        statusText: response.statusText,
        responseContentType: response.headers.get('content-type') || '',
        ...(organizationId && { organizationId }),
      };

      const clonedReponse = response.clone();
      try {
        extraErrorData.first4kOfResponse = (await clonedReponse.text()).slice(0, 4096);
      } catch {
        // ignore errors when already handling errors...
      }

      errorExceptInTest(errorMessage, extraErrorData);
      if (trackInSentry) {
        captureMessage(errorMessage, {
          level: 'error',
          extra: extraErrorData,
          tags: { source: 'openrouter-proxy' },
          user: { id: user.id },
        });
      }
    })()
  );
}

// ============================================================================
// Shared Helper Functions
// ============================================================================

export type OrganizationRestrictionResult = {
  error: NextResponse | null;
  providerConfig?: OpenRouterProviderConfig;
};

/**
 * Checks organization-level restrictions for model and provider access.
 *
 * Model allow list restrictions only apply to Enterprise plans.
 * Provider allow list and data collection settings apply to all plans.
 *
 * @param params.modelId - The model ID being requested
 * @param params.settings - Organization settings (may be undefined for non-org users)
 * @param params.organizationPlan - The organization's plan type (undefined for non-org users)
 * @returns Object with error response (if blocked) and provider config to apply
 */
export function checkOrganizationModelRestrictions(params: {
  modelId: string;
  settings?: OrganizationSettings;
  organizationPlan?: OrganizationPlan;
}): OrganizationRestrictionResult {
  if (!params.settings) return { error: null };

  const normalizedModelId = normalizeModelId(params.modelId);

  // Model deny list restrictions only apply to Enterprise plans
  // Teams plans should allow all models by default
  if (params.organizationPlan === 'enterprise') {
    const modelDenyList = params.settings.model_deny_list;
    if (
      modelDenyList &&
      modelDenyList.some(entry => normalizeModelId(entry) === normalizedModelId)
    ) {
      return { error: modelNotAllowedResponse() };
    }
  }

  const providerDenyList = params.settings.provider_deny_list;
  const dataCollection = params.settings.data_collection;

  const providerConfig: OpenRouterProviderConfig = {};

  if (params.organizationPlan === 'enterprise' && providerDenyList && providerDenyList.length > 0) {
    providerConfig.ignore = providerDenyList;
  }

  // Setting this only if it's set as an override on the organization settings
  if (dataCollection) {
    providerConfig.data_collection = dataCollection;
  }

  return {
    error: null,
    providerConfig: Object.keys(providerConfig).length > 0 ? providerConfig : undefined,
  };
}

export function extractHeaderAndLimitLength(request: NextRequest, name: string) {
  return request.headers.get(name)?.slice(0, 500)?.trim() || null;
}

export function extractFraudAndProjectHeaders(request: NextRequest) {
  return {
    fraudHeaders: getFraudDetectionHeaders(request.headers),
    xKiloCodeVersion: request.headers.get('X-KiloCode-Version'),
    projectId: normalizeProjectId(request.headers.get('X-KiloCode-ProjectId')),
    numericKiloCodeVersion:
      getXKiloCodeVersionNumber(request.headers.get('X-KiloCode-Version')) || 0,
  };
}

const wrapFimSuffixIntoSystemPrompt = (() => {
  const { begin, end } = fimSuffixFakeSysPrompMarkers;
  const wrapperLen = begin.length + end.length;
  return (suffix: string) => begin + suffix.slice(0, 100 - wrapperLen) + end;
})();

export function extractFimPromptInfo(body: { prompt: string; suffix?: string | null }): PromptInfo {
  return {
    system_prompt_prefix: wrapFimSuffixIntoSystemPrompt(body.suffix || ''), // suffix = context
    system_prompt_length: (body.suffix || '').length + body.prompt.length,
    user_prompt_prefix: body.prompt.slice(0, 100), // prompt = user input
  };
}

// ============================================================================
// FIM-Specific Code
// ============================================================================

export type FimUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type MistralFimCompletion = {
  id: string;
  object: 'fim.completion';
  model: string;
  usage: FimUsage;
  created: number;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string;
  }>;
};

export type MistralFimStreamChunk = {
  id: string;
  object: 'fim.completion.chunk';
  model: string;
  created: number;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: FimUsage; // Only present in final chunk
};

function computeInceptionFimMicrodollarCost(usage: FimUsage): number {
  return Math.round(usage.prompt_tokens * 0.25 + usage.completion_tokens * 0.75);
}

function computeFimMicrodollarCost(usage: FimUsage, provider: ProviderId): number {
  switch (provider) {
    case 'mistral':
      return Math.round(usage.prompt_tokens * 0.3 + usage.completion_tokens * 0.9);
    case 'inception':
      return computeInceptionFimMicrodollarCost(usage);
    default:
      console.error('Unknown provider for FIM cost calculation', provider);
      return 0;
  }
}

function parseMistralFimUsageFromString(
  response: string,
  provider: ProviderId,
  statusCode: number
): MicrodollarUsageStats {
  const json: MistralFimCompletion = JSON.parse(response);
  const cost_mUsd = computeFimMicrodollarCost(json.usage, provider);

  return {
    messageId: json.id,
    model: json.model,
    responseContent: json.choices[0]?.text || '',
    hasError: !json.model || statusCode >= 400,
    inference_provider: provider,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: json.usage.completion_tokens,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: statusCode,
  };
}

async function parseMistralFimUsageFromStream(
  stream: ReadableStream,
  requestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  requestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'fim-stream-processing',
    op: 'performance',
  });
  const timeToFirstTokenSpan = startInactiveSpan({
    name: 'time-to-first-token',
    op: 'performance',
  });

  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = statusCode >= 400;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: FimUsage | undefined;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute('fim.time_to_first_token_ms', performance.now() - startedAt);
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') return;

      try {
        const json: MistralFimStreamChunk = JSON.parse(event.data);

        model = json.model ?? model;
        messageId = json.id ?? messageId;
        usage = json.usage ?? usage; // Usage comes in final chunk

        const contentDelta = json.choices?.[0]?.delta?.content;
        if (contentDelta) {
          responseContent += contentDelta;
        }
      } catch (e) {
        reportedError = true;
        captureException(e, {
          tags: { source: 'fim_sse_parsing' },
          extra: { eventData: event.data },
        });
      }
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseStreamParser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }

  if (!usage) {
    captureMessage('SUSPICIOUS: No usage info in FIM stream', {
      level: 'error',
      tags: { source: 'fim_usage_processing' },
      extra: { messageId, model },
    });
  }

  return {
    messageId,
    model,
    responseContent,
    hasError: reportedError,
    inference_provider: provider,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd: usage ? computeFimMicrodollarCost(usage, provider) : 0,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: statusCode,
  };
}

export function countAndStoreFimUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  const logFileExtension = usageContext.isStreaming ? '.log.resp.sse' : '.log.resp.json';
  debugSaveProxyResponseStream(clonedResponse, logFileExtension);

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : usageContext.isStreaming
      ? parseMistralFimUsageFromStream(
          clonedResponse.body,
          requestSpan,
          usageContext.provider,
          statusCode
        )
      : clonedResponse
          .text()
          .then(content =>
            parseMistralFimUsageFromString(content, usageContext.provider, statusCode)
          );

  after(
    usageStatsPromise.then(usageStats => {
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No FIM usage information', {
          level: 'error',
          tags: { source: 'fim_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      usageStats.market_cost = usageStats.cost_mUsd;

      if (usageContext.user_byok) {
        usageStats.cost_mUsd = 0;
      }

      // Use the same logMicrodollarUsage as OpenRouter!
      return logMicrodollarUsage(usageStats, usageContext);
    })
  );
}

// ============================================================================
// Embedding-Specific Code
// ============================================================================

type EmbeddingUsage = {
  prompt_tokens: number;
  total_tokens: number;
  cost?: number;
};

type EmbeddingResponse = {
  id?: string;
  object: 'list';
  model: string;
  usage: EmbeddingUsage;
};

export function parseEmbeddingUsageFromResponse(
  responseText: string,
  statusCode: number
): MicrodollarUsageStats {
  const json: EmbeddingResponse = JSON.parse(responseText);

  // Upstream providers (OpenRouter, Vercel) include cost in USD → convert to microdollars.
  const cost_mUsd = json.usage.cost != null ? toMicrodollars(json.usage.cost) : 0;

  return {
    messageId: json.id ?? null,
    model: json.model,
    responseContent: '',
    hasError: !json.model || statusCode >= 400,
    inference_provider: null,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: false,
    status_code: statusCode,
  };
}

export function extractEmbeddingPromptInfo(body: { input: unknown }): PromptInfo {
  const inputStr =
    body.input == null
      ? ''
      : typeof body.input === 'string'
        ? body.input
        : Array.isArray(body.input) && typeof body.input[0] === 'string'
          ? body.input[0]
          : JSON.stringify(body.input).slice(0, 100);
  return {
    system_prompt_prefix: '',
    system_prompt_length: 0,
    user_prompt_prefix: inputStr.slice(0, 100),
  };
}

export function countAndStoreEmbeddingUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  debugSaveProxyResponseStream(clonedResponse, '.log.resp.json');

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : clonedResponse
        .text()
        .then(text => parseEmbeddingUsageFromResponse(text, statusCode))
        .catch(() => null);

  after(
    usageStatsPromise.then(usageStats => {
      requestSpan?.end();
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No embedding usage information', {
          level: 'error',
          tags: { source: 'embedding_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      // Preserve the real upstream cost for analytics before zeroing for BYOK
      usageStats.market_cost = usageStats.cost_mUsd;

      if (usageContext.user_byok) {
        usageStats.cost_mUsd = 0;
      }

      return logMicrodollarUsage(usageStats, usageContext);
    })
  );
}

// ============================================================================
// Proxied Chat Completion Helper
// ============================================================================

export type ProxiedChatCompletionRequest = {
  authToken: string;
  version: string;
  userAgent: string;
  body: OpenRouterChatCompletionRequest;
  organizationId?: string;
  /** Feature attribution value for microdollar usage tracking. */
  feature?: FeatureValue;
};

export type ProxiedChatCompletionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

/**
 * Send a non-streaming chat completion request through the internal proxy endpoint.
 * This is useful for server-side code that needs to make LLM requests (e.g., Slack bot).
 */
export async function sendProxiedChatCompletion<T>(
  request: ProxiedChatCompletionRequest
): Promise<ProxiedChatCompletionResult<T>> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${request.authToken}`,
    'X-KiloCode-Version': request.version,
    'User-Agent': request.userAgent,
  });

  if (request.organizationId) {
    headers.set('X-KiloCode-OrganizationId', request.organizationId);
  }

  if (request.feature) {
    headers.set(FEATURE_HEADER, request.feature);
  }

  const response = await fetch(`${APP_URL}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...request.body,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText };
  }

  const data: T = await response.json();
  return { ok: true, data };
}
