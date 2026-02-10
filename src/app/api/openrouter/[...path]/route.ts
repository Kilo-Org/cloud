import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { stripRequiredPrefix } from '@/lib/utils';
import { generateProviderSpecificHash } from '@/lib/providerHash';
import { extractPromptInfo, type MicrodollarUsageContext } from '@/lib/processUsage';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { applyProviderSpecificLogic, getProvider, openRouterRequest } from '@/lib/providers';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user.server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  isFreeModel,
  isDataCollectionRequiredOnKiloCodeOnly,
  isDeadFreeModel,
  isSlackbotOnlyModel,
  isStealthModelOnKiloCodeOnly,
} from '@/lib/models';
import {
  accountForMicrodollarUsage,
  alphaPeriodEndedResponse,
  captureProxyError,
  checkOrganizationModelRestrictions,
  dataCollectionRequiredResponse,
  estimateChatTokens,
  extractFraudAndProjectHeaders,
  invalidPathResponse,
  invalidRequestResponse,
  makeErrorReadable,
  modelDoesNotExistResponse,
  extractHeaderAndLimitLength,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
} from '@/lib/llm-proxy-helpers';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { ENABLE_TOOL_REPAIR, repairTools } from '@/lib/tool-calling';
import { isFreePromptTrainingAllowed } from '@/lib/providers/openrouter/types';
import { redactedModelResponse } from '@/lib/redactedModelResponse';
import {
  createAnonymousContext,
  isAnonymousContext,
  type AnonymousUserContext,
} from '@/lib/anonymous';
import { checkFreeModelRateLimit, logFreeModelRequest } from '@/lib/free-model-rate-limiter';
import { classifyAbuse } from '@/lib/abuse-service';
import { KILO_AUTO_MODEL_ID } from '@/lib/kilo-auto-model';
import {
  emitApiMetricsForResponse,
  getToolsAvailable,
  getToolsUsed,
} from '@/lib/o11y/api-metrics.server';
import { handleRequestLogging } from '@/lib/handleRequestLogging';

const MAX_TOKENS_LIMIT = 99999999999; // GPT4.1 default is ~32k

const OPUS = 'anthropic/claude-opus-4.6';
const SONNET = 'anthropic/claude-sonnet-4.5';

// Mode → model mappings for kilo/auto routing.
// Add/remove/modify entries here to change routing behavior.
const MODE_TO_MODEL = new Map<string, string>([
  // Opus modes (planning, reasoning, orchestration, debugging)
  ['plan', OPUS],
  ['general', OPUS],
  ['architect', OPUS],
  ['orchestrator', OPUS],
  ['ask', OPUS],
  ['debug', OPUS],
  // Sonnet modes (implementation, exploration)
  ['build', SONNET],
  ['explore', SONNET],
  ['code', SONNET],
]);

const DEFAULT_AUTO_MODEL = SONNET;

function resolveAutoModel(modeHeader: string | null) {
  const mode = modeHeader?.trim().toLowerCase() ?? 'build';
  return MODE_TO_MODEL.get(mode) ?? DEFAULT_AUTO_MODEL;
}

function validatePath(url: URL) {
  const path = stripRequiredPrefix(url.pathname, '/api/openrouter');

  return path === '/chat/completions' ? { path } : { errorResponse: invalidPathResponse() };
}

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  const url = new URL(request.url);

  const { errorResponse, path } = validatePath(url);
  if (errorResponse) return errorResponse;

  // Parse body first to check model before auth (needed for anonymous access)
  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  let requestBodyParsed: OpenRouterChatCompletionRequest;
  try {
    requestBodyParsed = JSON.parse(requestBodyText);
    // Inject or merge stream_options.include_usage = true
    requestBodyParsed.stream_options = {
      ...(requestBodyParsed.stream_options || {}),
      include_usage: true,
    };
  } catch (e) {
    captureException(e, {
      extra: {
        requestBodyText,
      },
      tags: { source: 'openrouter-proxy' },
    });
    return invalidRequestResponse();
  }

  if (!requestBodyParsed.model) {
    return modelDoesNotExistResponse();
  }

  const requestedModel = requestBodyParsed.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

  const requestedAutoModel = requestedModelLowerCased === KILO_AUTO_MODEL_ID;

  // "kilo/auto" is a quasi-model id that resolves to a real model based on x-kilocode-mode.
  // After this resolution, the rest of the proxy flow behaves as if the client requested
  // the resolved model directly.
  if (requestedAutoModel) {
    const modeHeader = request.headers.get('x-kilocode-mode');
    requestBodyParsed.model = resolveAutoModel(modeHeader);
  }

  const originalModelIdLowerCased = requestBodyParsed.model.toLowerCase();

  const isRequestedModelFree = isFreeModel(originalModelIdLowerCased);

  // Extract IP for all requests (needed for free model rate limiting)
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ipAddress) {
    return NextResponse.json({ error: 'Unable to determine client IP' }, { status: 400 });
  }

  // For FREE models: check IP rate limit BEFORE auth, log at start
  if (isRequestedModelFree) {
    const rateLimitResult = await checkFreeModelRateLimit(ipAddress);
    if (!rateLimitResult.allowed) {
      console.warn(
        `Free model rate limit exceeded, ip address: ${ipAddress}, model: ${originalModelIdLowerCased}, request count: ${rateLimitResult.requestCount}`
      );
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          message:
            'Free model usage limit reached. Please try again later or upgrade to a paid model.',
        },
        { status: 429 }
      );
    }
  }

  // Now check auth
  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId: authOrganizationId,
    internalApiUse: authInternalApiUse,
  } = await getUserFromAuth({ adminOnly: false });
  authSpan.end();

  let user: typeof maybeUser | AnonymousUserContext;
  let organizationId: string | undefined = authOrganizationId;
  let internalApiUse: boolean | undefined = authInternalApiUse;

  if (authFailedResponse) {
    // No valid auth
    if (!isRequestedModelFree) {
      // Paid model requires authentication
      return authFailedResponse;
    }
    // Anonymous access for free model (already rate-limited above)
    user = createAnonymousContext(ipAddress);
    organizationId = undefined;
    internalApiUse = false;
  } else {
    user = maybeUser;
  }

  // Log to free_model_usage for rate limiting (at request start, before processing)
  if (isRequestedModelFree) {
    await logFreeModelRequest(
      ipAddress,
      originalModelIdLowerCased,
      isAnonymousContext(user) ? undefined : user.id
    );
  }

  // Use new shared helper for fraud & project headers
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const taskId = request.headers.get('X-KiloCode-TaskId') ?? undefined;
  const { provider, userByok } = await getProvider(
    originalModelIdLowerCased,
    requestBodyParsed,
    user,
    organizationId
  );

  console.debug(`Routing request to ${provider.id}`);

  // Start abuse classification early (non-blocking) - we'll await it before creating usage context
  const classifyPromise = classifyAbuse(request, requestBodyParsed, {
    kiloUserId: user.id,
    organizationId,
    projectId,
    provider: provider.id,
    isByok: !!userByok,
  });

  // large responses may run longer than the 800s serverless function timeout, usually this value is set to 8192 tokens
  if (requestBodyParsed.max_tokens && requestBodyParsed.max_tokens > MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Max tokens limit exceeded: ${user.id}`, {
      maxTokens: requestBodyParsed.max_tokens,
      bodyText: requestBodyText,
    });
    return temporarilyUnavailableResponse();
  }

  if (isDeadFreeModel(originalModelIdLowerCased)) {
    return alphaPeriodEndedResponse();
  }

  // Slackbot-only models are only available through Kilo for Slack (internalApiUse)
  if (isSlackbotOnlyModel(originalModelIdLowerCased) && !internalApiUse) {
    return modelDoesNotExistResponse();
  }

  // Extract properties for usage context
  const tokenEstimates = estimateChatTokens(requestBodyParsed);
  const promptInfo = extractPromptInfo(requestBodyParsed);

  const usageContext: MicrodollarUsageContext = {
    kiloUserId: user.id,
    provider: provider.id,
    requested_model: originalModelIdLowerCased,
    promptInfo,
    max_tokens: requestBodyParsed.max_tokens ?? null,
    has_middle_out_transform: requestBodyParsed.transforms?.includes('middle-out') ?? false,
    estimatedInputTokens: tokenEstimates.estimatedInputTokens,
    estimatedOutputTokens: tokenEstimates.estimatedOutputTokens,
    fraudHeaders,
    isStreaming: requestBodyParsed.stream === true,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    user_byok: !!userByok,
    has_tools: (requestBodyParsed.tools?.length ?? 0) > 0,
  };

  setTag('ui.ai_model', requestBodyParsed.model);

  // Skip balance/org checks for anonymous users - they can only use free models
  if (!isAnonymousContext(user)) {
    const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user);

    if (balance <= 0 && !isFreeModel(originalModelIdLowerCased) && !userByok) {
      return await usageLimitExceededResponse(user, balance);
    }

    // Organization model/provider restrictions check
    // Model allow list only applies to Enterprise plans
    // Provider allow list applies to Enterprise plans; data collection applies to all plans
    const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
      modelId: originalModelIdLowerCased,
      settings,
      organizationPlan: plan,
    });
    if (modelRestrictionError) return modelRestrictionError;

    if (providerConfig) {
      requestBodyParsed.provider = providerConfig;
    }
  }

  sentryRootSpan()?.setAttribute(
    'openrouter.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const openrouterRequestSpan = startInactiveSpan({
    name: 'openrouter-request-start',
    op: 'http.client',
  });

  if (
    isDataCollectionRequiredOnKiloCodeOnly(originalModelIdLowerCased) &&
    !isFreePromptTrainingAllowed(requestBodyParsed.provider)
  ) {
    return dataCollectionRequiredResponse();
  }

  if (taskId) {
    requestBodyParsed.prompt_cache_key = generateProviderSpecificHash(user.id + taskId, provider);
  }

  requestBodyParsed.safety_identifier = generateProviderSpecificHash(user.id, provider);
  requestBodyParsed.user = requestBodyParsed.safety_identifier; // deprecated, but this is what OpenRouter uses

  if (ENABLE_TOOL_REPAIR) {
    repairTools(requestBodyParsed);
  }

  const toolsAvailable = getToolsAvailable(requestBodyParsed.tools);
  const toolsUsed = getToolsUsed(requestBodyParsed.messages);

  const extraHeaders: Record<string, string> = {};
  applyProviderSpecificLogic(
    provider,
    originalModelIdLowerCased,
    requestBodyParsed,
    extraHeaders,
    userByok
  );

  const response = await openRouterRequest({
    path,
    search: url.search,
    method: request.method,
    body: requestBodyParsed,
    extraHeaders,
    provider,
    signal: request.signal,
  });
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: requestBodyParsed.stream === true,
      userByok: !!userByok,
      mode: request.headers.get('x-kilocode-mode')?.trim() || undefined,
      provider: provider.id,
      requestedModel: requestedModelLowerCased,
      resolvedModel: requestBodyParsed.model.toLowerCase(),
      toolsAvailable,
      toolsUsed,
      ttfbMs,
      statusCode: response.status,
    },
    response.clone(),
    requestStartedAt
  );
  usageContext.status_code = response.status;

  // Handle OpenRouter 402 errors - don't pass them through to the client. We need to pay, not them.
  if (response.status === 402) {
    await captureProxyError({
      user,
      request: requestBodyParsed,
      response,
      organizationId,
      model: requestBodyParsed.model,
      errorMessage: `${provider.id} returned 402 Payment Required`,
      trackInSentry: true,
    });

    // Return a service unavailable error instead of the 402
    return temporarilyUnavailableResponse();
  }

  if (response.status >= 400) {
    await captureProxyError({
      user,
      request: requestBodyParsed,
      response,
      organizationId,
      model: requestBodyParsed.model,
      errorMessage: `${provider.id} returned error ${response.status}`,
      trackInSentry: response.status >= 500,
    });
  }

  const clonedReponse = response.clone(); // reading from body is side-effectful

  // Await abuse classification (with timeout) to get request_id for cost tracking correlation
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const classifyResult = await Promise.race([
    classifyPromise.finally(() => timeoutId && clearTimeout(timeoutId)),
    new Promise<null>(resolve => {
      timeoutId = setTimeout(() => resolve(null), 2000);
    }),
  ]);
  if (classifyResult) {
    console.log('Abuse classification result:', {
      verdict: classifyResult.verdict,
      risk_score: classifyResult.risk_score,
      signals: classifyResult.signals,
      identity_key: classifyResult.context.identity_key,
      kilo_user_id: user.id,
      requested_model: originalModelIdLowerCased,
      rps: classifyResult.context.requests_per_second,
      request_id: classifyResult.request_id,
    });
    usageContext.abuse_request_id = classifyResult.request_id;
  }

  accountForMicrodollarUsage(clonedReponse, usageContext, openrouterRequestSpan);

  handleRequestLogging({
    clonedResponse: response.clone(),
    user: maybeUser,
    organization_id: organizationId || null,
    provider: provider.id,
    model: originalModelIdLowerCased,
    request: requestBodyParsed,
  });

  {
    const errorResponse = await makeErrorReadable({
      requestedModel: originalModelIdLowerCased,
      request: requestBodyParsed,
      response,
    });
    if (errorResponse) {
      return errorResponse;
    }
  }

  if (isStealthModelOnKiloCodeOnly(originalModelIdLowerCased)) {
    return redactedModelResponse(response, originalModelIdLowerCased);
  }

  return wrapInSafeNextResponse(response);
}
