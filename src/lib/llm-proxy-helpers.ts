import { after, NextResponse, type NextRequest } from 'next/server';
import {
  type MicrodollarUsageContext,
  type PromptInfo,
  type MicrodollarUsageStats,
  countAndStoreUsage,
  logMicrodollarUsage,
} from '@/lib/processUsage';
import { startInactiveSpan, captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL, FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { type User } from '@/db/schema';
import { errorExceptInTest, warnExceptInTest } from '@/lib/utils.server';

import type { Span } from '@sentry/nextjs';
import { debugSaveProxyResponseStream } from '@/lib/debugUtils';
import type {
  OrganizationSettings,
  OrganizationPlan,
} from '@/lib/organizations/organization-types';
import type { OpenRouterProviderConfig } from '@/lib/providers/openrouter/types';
import { extraRequiredProviders } from '@/lib/models';
import { getFraudDetectionHeaders } from '@/lib/utils';
import { normalizeProjectId } from '@/lib/normalizeProjectId';
import { getXKiloCodeVersionNumber } from '@/lib/userAgent';
import { normalizeModelId } from '@/lib/providers/openrouter';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { sentryRootSpan } from './getRootSpan';
import { isStealthModelOnKiloCodeOnly, kiloFreeModels } from '@/lib/models';

// FIM suffix markers for tracking purposes - used to wrap suffix in a fake system prompt format
// This allows FIM requests to be tracked consistently with chat requests
const fimSuffixFakeSysPrompMarkers = { begin: '[FIM_SUFFIX:', end: ']' } as const;

export function invalidPathResponse() {
  return NextResponse.json(
    {
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    },
    { status: 400 }
  );
}

export function invalidRequestResponse() {
  return NextResponse.json(
    {
      error: 'Invalid request',
      message: 'Could not parse request body. Please ensure it is valid JSON.',
    },
    { status: 400 }
  );
}

export function temporarilyUnavailableResponse() {
  return NextResponse.json(
    {
      error: 'Service Unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    },
    { status: 503 }
  );
}

export async function usageLimitExceededResponse(user: User, balance?: number) {
  const payments = await summarizeUserPayments(user.id);

  const title = !payments.payments_count ? 'Paid Model - Credits Required' : 'Low Credit Warning!';

  const message = !payments.payments_count
    ? `This is a paid model. To use paid models, you need to add credits. Get $${FIRST_TOPUP_BONUS_AMOUNT(new Date(Date.now() + 10 * 60 * 1000))} free on your first topup!`
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
      message: error,
    },
    { status: 400 }
  );
}

export function alphaPeriodEndedResponse() {
  // https://github.com/Kilo-Org/kilocode/blob/50d6bd482bec6fae7d1c80b14ffb064de3761507/src/shared/kilocode/errorUtils.ts#L13
  const error = `The alpha period for this model has ended.`;
  return NextResponse.json({ error: error, message: error }, { status: 404 });
}

async function stealthModelError(response: Response) {
  const error = 'Stealth model unable to process request';
  warnExceptInTest(`Responding with ${response.status} ${error}`);
  return NextResponse.json({ error, message: error }, { status: response.status });
}

function estimateTokenCount(request: OpenRouterChatCompletionRequest) {
  return Math.round(
    JSON.stringify(request).length / 4 + (request.max_completion_tokens ?? request.max_tokens ?? 0)
  );
}

export async function makeErrorReadable({
  requestedModel,
  request,
  response,
}: {
  requestedModel: string;
  request: OpenRouterChatCompletionRequest;
  response: Response;
}) {
  if (response.status < 400) {
    return undefined;
  }

  // Sometimes we get generic or nonsensical errors when the context length is exceeded
  // (such as "Internal Server Error" or "No allowed providers are available for the selected model")
  const model = kiloFreeModels.find(m => m.public_id === requestedModel);
  if (model) {
    const estimatedTokenCount = estimateTokenCount(request);
    if (estimatedTokenCount >= model.context_length) {
      const error = `The maximum context length is ${model.context_length} tokens. However, about ${estimatedTokenCount} tokens were requested.`;
      warnExceptInTest(`Responding with ${response.status} ${error}`);
      return NextResponse.json({ error, message: error }, { status: response.status });
    }
  }

  if (isStealthModelOnKiloCodeOnly(requestedModel)) {
    return await stealthModelError(response);
  }

  return undefined;
}

export function modelNotAllowedResponse() {
  return NextResponse.json(
    {
      error: 'Model not allowed for your team.',
      message: 'The requested model is not allowed for your team.',
    },
    { status: 404 }
  );
}

export function modelDoesNotExistResponse() {
  return NextResponse.json(
    {
      error: 'Model not found',
      message: 'The requested model could not be found.',
    },
    { status: 404 }
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

  // Model allow list restrictions only apply to Enterprise plans
  // Teams plans should allow all models by default
  if (params.organizationPlan === 'enterprise') {
    const modelAllowList = params.settings.model_allow_list || [];

    // If there are model restrictions, check them
    if (modelAllowList.length > 0) {
      // Check for exact model match
      const isExactMatch = modelAllowList.includes(normalizedModelId);

      // Check for wildcard match (e.g., "anthropic/*" matches "anthropic/claude-3-opus")
      const providerSlug = normalizedModelId.split('/')[0];
      const wildcardEntry = `${providerSlug}/*`;
      const isWildcardMatch = modelAllowList.includes(wildcardEntry);

      if (!isExactMatch && !isWildcardMatch) {
        return { error: modelNotAllowedResponse() };
      }
    }
  }

  const providerAllowList = params.settings.provider_allow_list || [];
  const dataCollection = params.settings.data_collection;

  const providerConfig: OpenRouterProviderConfig = {};

  if (params.organizationPlan === 'enterprise' && providerAllowList.length > 0) {
    // Check if the model requires specific providers that aren't in the allow list
    const requiredProviders = extraRequiredProviders(normalizedModelId);
    if (requiredProviders && !requiredProviders.every(p => providerAllowList.includes(p))) {
      console.error(
        `This FREE model requires ALL of these providers to be allowed: ${requiredProviders.join(', ')}`
      );
      // This is overly strict, but checking for just one of them is not enough,
      // because this list overrides the org allow list
      return { error: modelNotAllowedResponse() };
    }
    providerConfig.only = providerAllowList;
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

export function estimateChatTokens(body: OpenRouterChatCompletionRequest): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
} {
  if (!body.messages || !Array.isArray(body.messages)) {
    return { estimatedInputTokens: 0, estimatedOutputTokens: 0 };
  }
  const overallLength = body.messages.reduce(
    (sum, m) =>
      sum +
      (typeof m.content === 'string'
        ? m.content?.length
        : Array.isArray(m.content)
          ? m.content
              .filter(c => c.type === 'text')
              .map(c => c.text.length)
              .reduce((l, str) => str + 1 + l, 0)
          : 0),
    0
  );
  return {
    estimatedInputTokens: overallLength / 4,
    estimatedOutputTokens: overallLength / 4, // Conservative estimate
  };
}

export function estimateFimTokens(body: {
  prompt: string;
  suffix?: string | null;
  max_tokens?: number | null;
}): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
} {
  const promptLength = body.prompt.length + (body.suffix?.length || 0);
  return {
    estimatedInputTokens: promptLength / 4,
    estimatedOutputTokens: (body.max_tokens || 1024) / 2,
  };
}

// ============================================================================
// FIM-Specific Code
// ============================================================================

export type MistralFimUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type MistralFimCompletion = {
  id: string;
  object: 'fim.completion';
  model: string;
  usage: MistralFimUsage;
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
  usage?: MistralFimUsage; // Only present in final chunk
};

function computeMistralFimMicrodollarCost(usage: MistralFimUsage): number {
  return Math.round(usage.prompt_tokens * 0.3 + usage.completion_tokens * 0.9);
}

function parseMistralFimUsageFromString(response: string): MicrodollarUsageStats {
  const json: MistralFimCompletion = JSON.parse(response);
  const cost_mUsd = computeMistralFimMicrodollarCost(json.usage);

  return {
    messageId: json.id,
    model: json.model,
    responseContent: json.choices[0]?.text || '',
    hasError: !json.model,
    inference_provider: 'mistral',
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
  };
}

async function parseMistralFimUsageFromStream(
  stream: ReadableStream,
  requestSpan: Span | undefined
): Promise<MicrodollarUsageStats> {
  requestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'mistral-fim-stream-processing',
    op: 'performance',
  });
  const timeToFirstTokenSpan = startInactiveSpan({
    name: 'time-to-first-token',
    op: 'performance',
  });

  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = false;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: MistralFimUsage | undefined;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute(
          'mistral.time_to_first_token_ms',
          performance.now() - startedAt
        );
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
    inference_provider: 'mistral',
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd: usage ? computeMistralFimMicrodollarCost(usage) : 0,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
  };
}

export function countAndStoreFimUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  const logFileExtension = usageContext.isStreaming ? '.log.resp.sse' : '.log.resp.json';
  debugSaveProxyResponseStream(clonedResponse, logFileExtension);

  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : usageContext.isStreaming
      ? parseMistralFimUsageFromStream(clonedResponse.body, requestSpan)
      : clonedResponse.text().then(content => parseMistralFimUsageFromString(content));

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

      // Use the same logMicrodollarUsage as OpenRouter!
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
