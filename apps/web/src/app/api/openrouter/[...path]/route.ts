import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { isOpenCodeBasedClient, isRooCodeBasedClient, stripRequiredPrefix } from '@/lib/utils';
import { applyTrackingIds } from '@/lib/providerHash';
import { extractPromptInfo as extractChatCompletionsPromptInfo } from '@/lib/processUsage';
import {
  validateFeatureHeader,
  FEATURE_HEADER,
  isUserRateLimitedFeature,
  type FeatureValue,
} from '@/lib/feature-detection';
import type {
  OpenRouterChatCompletionRequest,
  GatewayResponsesRequest,
  GatewayMessagesRequest,
  GatewayRequest,
} from '@/lib/providers/openrouter/types';
import { applyProviderSpecificLogic, getProvider, openRouterRequest } from '@/lib/providers';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user.server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  isFreeModel,
  isDeadFreeModel,
  isExcludedForFeature,
  isKiloExclusiveFreeModel,
  isKiloStealthModel,
} from '@/lib/models';
import {
  accountForMicrodollarUsage,
  captureProxyError,
  checkOrganizationModelRestrictions,
  dataCollectionRequiredResponse,
  extractFraudAndProjectHeaders,
  featureExclusiveModelResponse,
  invalidPathResponse,
  invalidRequestResponse,
  makeErrorReadable,
  modelDoesNotExistResponse,
  extractHeaderAndLimitLength,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
  forbiddenFreeModelResponse,
  storeAndPreviousResponseIdIsNotSupported,
  apiKindNotSupportedResponse,
} from '@/lib/llm-proxy-helpers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { ENABLE_TOOL_REPAIR, repairTools } from '@/lib/tool-calling';
import { isFreePromptTrainingAllowed } from '@/lib/providers/openrouter/types';
import {
  rewriteFreeModelResponse_ChatCompletions,
  rewriteFreeModelResponse_Messages,
  rewriteFreeModelResponse_Responses,
} from '@/lib/rewriteModelResponse';
import {
  createAnonymousContext,
  isAnonymousContext,
  type AnonymousUserContext,
} from '@/lib/anonymous';
import {
  checkFreeModelRateLimit,
  checkFreeModelRateLimitByUser,
  logFreeModelRequest,
  checkPromotionLimit,
} from '@/lib/free-model-rate-limiter';
import { PROMOTION_MAX_REQUESTS, PROMOTION_WINDOW_HOURS } from '@/lib/constants';
import { handleRequestLogging } from '@/lib/handleRequestLogging';
import { classifyAbuse } from '@/lib/abuse-service';
import {
  emitApiMetricsForResponse,
  getToolsAvailable,
  getToolsUsed,
} from '@/lib/o11y/api-metrics.server';
import { grokCodeFastOptimizedRequest } from '@/lib/custom-llm/customLlmRequest';
import { normalizeModelId } from '@/lib/model-utils';
import { isForbiddenFreeModel } from '@/lib/forbidden-free-models';
import { isCloudflareIP } from '@/lib/cloudflare-ip';
import { isKiloAutoModel } from '@/lib/kilo-auto';
import { applyResolvedAutoModel } from '@/lib/kilo-auto/resolution';
import { fixOpenCodeDuplicateReasoning } from '@/lib/providers/fixOpenCodeDuplicateReasoning';
import type { MicrodollarUsageContext, PromptInfo } from '@/lib/processUsage.types';
import { extractResponsesPromptInfo } from '@/lib/processUsage.responses';
import { extractMessagesPromptInfo } from '@/lib/processUsage.messages';
import {
  fixResponsesRequest,
  getMaxTokens,
  hasMiddleOutTransform,
} from '@/lib/providers/openrouter/request-helpers';

export const maxDuration = 800;

const MAX_TOKENS_LIMIT = 99999999999; // GPT4.1 default is ~32k

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';
const PROMOTION_MODEL_LIMIT_REACHED = 'PROMOTION_MODEL_LIMIT_REACHED';

function validatePath(
  url: URL
):
  | { path: '/chat/completions' | '/responses' | '/messages' }
  | { errorResponse: ReturnType<typeof invalidPathResponse> } {
  const pathSuffix =
    stripRequiredPrefix(url.pathname, '/api/gateway/v1') ??
    stripRequiredPrefix(url.pathname, '/api/openrouter/v1') ??
    stripRequiredPrefix(url.pathname, '/api/gateway') ??
    stripRequiredPrefix(url.pathname, '/api/openrouter');

  if (
    pathSuffix === '/chat/completions' ||
    pathSuffix === '/responses' ||
    pathSuffix === '/messages'
  ) {
    return { path: pathSuffix };
  }
  return { errorResponse: invalidPathResponse() };
}

function extractPromptInfo(requestBodyParsed: GatewayRequest): PromptInfo {
  if (requestBodyParsed.kind === 'messages') {
    return extractMessagesPromptInfo(requestBodyParsed.body);
  }
  if (requestBodyParsed.kind === 'responses') {
    return extractResponsesPromptInfo(requestBodyParsed.body);
  }
  return extractChatCompletionsPromptInfo(requestBodyParsed.body);
}

async function resolveRateLimit(
  feature: FeatureValue | null,
  ipAddress: string,
  authPromise: Promise<{ user: { id: string } | null }>
): Promise<
  | NextResponseType<unknown>
  | { result: { allowed: boolean; requestCount: number }; subject: string }
> {
  if (isUserRateLimitedFeature(feature) && isCloudflareIP(ipAddress)) {
    const { user } = await authPromise;
    if (!user) {
      return NextResponse.json(
        {
          error: 'Authentication required for this feature',
          error_type: ProxyErrorType.authentication_required,
        },
        { status: 401 }
      );
    }
    return {
      result: await checkFreeModelRateLimitByUser(user.id),
      subject: `user: ${user.id}`,
    };
  }
  return {
    result: await checkFreeModelRateLimit(ipAddress),
    subject: `ip address: ${ipAddress}`,
  };
}

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  const url = new URL(request.url);

  const pathResult = validatePath(url);
  if ('errorResponse' in pathResult) return pathResult.errorResponse;
  const { path } = pathResult;

  // Parse body first to check model before auth (needed for anonymous access)
  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  let requestBodyParsed: GatewayRequest;
  try {
    if (path === '/chat/completions') {
      const body: OpenRouterChatCompletionRequest = JSON.parse(requestBodyText);
      // Inject or merge stream_options.include_usage = true (only when streaming)
      if (body.stream) {
        body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      }
      requestBodyParsed = { kind: 'chat_completions', body };
    } else if (path === '/messages') {
      const body: GatewayMessagesRequest = JSON.parse(requestBodyText);
      requestBodyParsed = { kind: 'messages', body };
    } else {
      const body: GatewayResponsesRequest = JSON.parse(requestBodyText);
      requestBodyParsed = { kind: 'responses', body };
    }
  } catch (e) {
    captureException(e, {
      extra: { requestBodyText },
      tags: { source: 'openrouter-proxy' },
    });
    return invalidRequestResponse();
  }

  delete requestBodyParsed.body.models; // OpenRouter specific field we do not support
  if (
    typeof requestBodyParsed.body.model !== 'string' ||
    requestBodyParsed.body.model.trim().length === 0
  ) {
    return modelDoesNotExistResponse();
  }

  const requestedModel = requestBodyParsed.body.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();
  const isLegacyOpenRouterPath = url.pathname.includes('/openrouter');

  const feature = validateFeatureHeader(
    request.headers.get(FEATURE_HEADER) || (isLegacyOpenRouterPath ? '' : 'direct-gateway')
  );

  const authPromise = getUserFromAuth({ adminOnly: false });
  const balanceAndSettingsPromise = authPromise.then(res =>
    res.user
      ? getBalanceAndOrgSettings(res.organizationId, res.user)
      : { balance: 0, settings: undefined, plan: undefined }
  );

  const modeHeader = extractHeaderAndLimitLength(request, 'x-kilocode-mode');
  let autoModel: string | null = null;
  if (isKiloAutoModel(requestedModelLowerCased)) {
    autoModel = requestedModelLowerCased;
    await applyResolvedAutoModel(
      requestedModelLowerCased,
      requestBodyParsed,
      modeHeader,
      feature,
      authPromise.then(res => res.user),
      balanceAndSettingsPromise.then(res => res.balance)
    );
  }

  const originalModelIdLowerCased = requestBodyParsed.body.model.toLowerCase();

  // Reject early (before rate limiting) if the model is exclusive to other features.
  if (isExcludedForFeature(originalModelIdLowerCased, feature)) {
    console.warn(
      `Model ${originalModelIdLowerCased} is not available for feature ${feature}; rejecting.`
    );
    return featureExclusiveModelResponse(originalModelIdLowerCased);
  }

  // Extract IP for all requests (needed for free model rate limiting)
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ipAddress) {
    return NextResponse.json(
      {
        error: 'Unable to determine client IP',
        error_type: ProxyErrorType.missing_client_ip,
      },
      { status: 400 }
    );
  }

  // For FREE models: check rate limit, log at start.
  // Server-side products (cloud-agent, code-review, app-builder) rate-limit
  // per user when the request comes from Cloudflare IPs (Kilo infrastructure).
  // All other products rate-limit per IP (fast pre-auth path).
  if (isKiloExclusiveFreeModel(originalModelIdLowerCased)) {
    const rateLimit = await resolveRateLimit(feature, ipAddress, authPromise);
    if (rateLimit instanceof NextResponse) return rateLimit;

    if (!rateLimit.result.allowed) {
      console.warn(
        `Free model rate limit exceeded, ${rateLimit.subject}, model: ${originalModelIdLowerCased}, request count: ${rateLimit.result.requestCount}`
      );
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          error_type: ProxyErrorType.rate_limit_exceeded,
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
    botId: authBotId,
    tokenSource: authTokenSource,
  } = await authPromise;
  authSpan.end();

  let user: typeof maybeUser | AnonymousUserContext;
  let organizationId: string | undefined = authOrganizationId;
  let botId: string | undefined = authBotId;
  let tokenSource: string | undefined = authTokenSource;

  if (authFailedResponse) {
    // No valid auth
    if (!isFreeModel(originalModelIdLowerCased)) {
      // Paid model requires authentication
      return NextResponse.json(
        {
          error: {
            code: PAID_MODEL_AUTH_REQUIRED,
            message: 'You need to sign in to use this model.',
          },
          error_type: ProxyErrorType.paid_model_auth_required,
        },
        { status: 401 }
      );
    }

    const promotionLimit = await checkPromotionLimit(ipAddress);

    if (!promotionLimit.allowed) {
      console.warn(
        `Promotion model limit exceeded, ip: ${ipAddress}, ` +
          `model: ${originalModelIdLowerCased}, ` +
          `requests: ${promotionLimit.requestCount}/${PROMOTION_MAX_REQUESTS} ` +
          `in ${PROMOTION_WINDOW_HOURS}h window`
      );

      return NextResponse.json(
        {
          error: {
            code: PROMOTION_MODEL_LIMIT_REACHED,
            message:
              'Sign up for free to continue and explore 500 other models. ' +
              'Takes 2 minutes, no credit card required. Or come back later.',
          },
          error_type: ProxyErrorType.promotion_limit_reached,
        },
        { status: 401 } // TODO: Change to 429 once the extension supports it (see kilocode errorUtils.ts)
      );
    }

    // Anonymous access for free model (already rate-limited above)
    user = createAnonymousContext(ipAddress);
    organizationId = undefined;
    botId = undefined;
    tokenSource = undefined;
  } else {
    user = maybeUser;
  }

  if (
    requestBodyParsed.kind === 'responses' &&
    (requestBodyParsed.body.store || requestBodyParsed.body.previous_response_id)
  ) {
    return storeAndPreviousResponseIdIsNotSupported();
  }

  // Log to free_model_usage for rate limiting (at request start, before processing)
  if (isKiloExclusiveFreeModel(originalModelIdLowerCased)) {
    await logFreeModelRequest(
      ipAddress,
      originalModelIdLowerCased,
      isAnonymousContext(user) ? undefined : user.id
    );
  }

  // Use new shared helper for fraud & project headers
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;
  const { provider, userByok, bypassAccessCheck } = await getProvider(
    originalModelIdLowerCased,
    requestBodyParsed,
    user,
    organizationId,
    taskId
  );
  if (!provider.supportedChatApis.includes(requestBodyParsed.kind)) {
    return apiKindNotSupportedResponse(
      requestBodyParsed.kind,
      provider.supportedChatApis,
      fraudHeaders
    );
  }

  console.debug(`Routing request to ${provider.id}`);

  // Start abuse classification early (non-blocking) - we'll await it before creating usage context
  const classifyPromise = classifyAbuse(request, requestBodyParsed, {
    kiloUserId: user.id,
    organizationId,
    projectId,
    provider: provider.id,
    isByok: !!userByok,
    feature,
  });

  // Large responses may run longer than the 800s serverless function timeout.
  const requestMaxTokens = getMaxTokens(requestBodyParsed);
  if (requestMaxTokens && requestMaxTokens > MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Max tokens limit exceeded: ${user.id}`, {
      maxTokens: requestMaxTokens,
      bodyText: requestBodyText,
    });
    return temporarilyUnavailableResponse();
  }

  if (
    isDeadFreeModel(originalModelIdLowerCased) ||
    (!autoModel && isForbiddenFreeModel(originalModelIdLowerCased))
  ) {
    console.warn(`User requested forbidden free model ${originalModelIdLowerCased}; rejecting.`);
    return forbiddenFreeModelResponse(fraudHeaders, feature);
  }

  // Extract properties for usage context
  const promptInfo = extractPromptInfo(requestBodyParsed);

  const usageContext: MicrodollarUsageContext = {
    api_kind: requestBodyParsed.kind,
    kiloUserId: user.id,
    provider: provider.id,
    requested_model: originalModelIdLowerCased,
    promptInfo,
    max_tokens: getMaxTokens(requestBodyParsed),
    has_middle_out_transform: hasMiddleOutTransform(requestBodyParsed),
    fraudHeaders,
    isStreaming: requestBodyParsed.body.stream === true,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    user_byok: !!userByok,
    has_tools: (requestBodyParsed.body.tools?.length ?? 0) > 0,
    botId,
    tokenSource,
    feature,
    session_id: taskId ?? null,
    mode: modeHeader,
    auto_model: autoModel,
  };

  setTag('ui.ai_model', requestBodyParsed.body.model);

  // Skip balance/org checks for anonymous users - they can only use free models
  if (!isAnonymousContext(user) && !bypassAccessCheck) {
    const { balance, settings, plan } = await balanceAndSettingsPromise;

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
      requestBodyParsed.body.provider = providerConfig;
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
    isKiloExclusiveFreeModel(originalModelIdLowerCased) &&
    !isFreePromptTrainingAllowed(requestBodyParsed.body.provider)
  ) {
    return dataCollectionRequiredResponse();
  }

  applyTrackingIds(requestBodyParsed, provider, user.id, taskId ?? null);

  if (requestBodyParsed.kind === 'chat_completions') {
    if (ENABLE_TOOL_REPAIR) {
      // Mostly a workaround for bugs in the old extension.
      repairTools(requestBodyParsed.body);
    }

    if (isOpenCodeBasedClient(fraudHeaders)) {
      // Workaround for bugs in the chat completions client.
      fixOpenCodeDuplicateReasoning(originalModelIdLowerCased, requestBodyParsed.body, taskId);
    }
  }

  if (requestBodyParsed.kind === 'responses') {
    fixResponsesRequest(requestBodyParsed.body);
  }

  const toolsAvailable = getToolsAvailable(requestBodyParsed);
  const toolsUsed = getToolsUsed(requestBodyParsed);

  const extraHeaders: Record<string, string> = {};
  applyProviderSpecificLogic(
    provider,
    originalModelIdLowerCased,
    requestBodyParsed,
    extraHeaders,
    userByok
  );

  let response: Response;
  if (requestBodyParsed.kind === 'chat_completions' && provider.id === 'martian') {
    response = await grokCodeFastOptimizedRequest(
      requestBodyParsed.body,
      isRooCodeBasedClient(fraudHeaders)
    );
  } else {
    response = await openRouterRequest({
      path,
      search: url.search,
      method: request.method,
      body: requestBodyParsed.body,
      extraHeaders,
      provider,
      signal: request.signal,
    });
  }
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: requestBodyParsed.body.stream === true,
      userByok: !!userByok,
      mode: modeHeader || undefined,
      provider: provider.id,
      requestedModel: requestedModelLowerCased,
      resolvedModel: normalizeModelId(originalModelIdLowerCased),
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
  // Skip this conversion when user BYOK is used - the 402 is about their account, not ours.
  if (response.status === 402 && !userByok) {
    await captureProxyError({
      user,
      request: requestBodyParsed.body,
      response,
      organizationId,
      model: requestBodyParsed.body.model,
      errorMessage: `${provider.id} returned 402 Payment Required`,
      trackInSentry: true,
    });

    // Return a service unavailable error instead of the 402
    return temporarilyUnavailableResponse();
  }

  if (response.status >= 400) {
    await captureProxyError({
      user,
      request: requestBodyParsed.body,
      response,
      organizationId,
      model: requestBodyParsed.body.model,
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
      identity_key: classifyResult.context?.identity_key,
      kilo_user_id: user.id,
      requested_model: originalModelIdLowerCased,
      rps: classifyResult.context?.requests_per_second,
      request_id: classifyResult.request_id,
    });
    usageContext.abuse_request_id = classifyResult.request_id;
  }

  accountForMicrodollarUsage(clonedReponse, usageContext, openrouterRequestSpan);

  await handleRequestLogging({
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
      isUserByok: !!userByok,
    });
    if (errorResponse) {
      return errorResponse;
    }
  }

  const isFreeModelRequiringCostRemoval =
    (provider.id === 'openrouter' || provider.id === 'vercel') &&
    isKiloExclusiveFreeModel(originalModelIdLowerCased);
  const isStealthModelRequiringNameRemoval =
    provider.id !== 'martian' && isKiloStealthModel(originalModelIdLowerCased);

  if (isFreeModelRequiringCostRemoval || isStealthModelRequiringNameRemoval) {
    if (requestBodyParsed.kind === 'chat_completions') {
      return rewriteFreeModelResponse_ChatCompletions(response, originalModelIdLowerCased);
    }
    if (requestBodyParsed.kind === 'responses') {
      return rewriteFreeModelResponse_Responses(response, originalModelIdLowerCased);
    }
    if (requestBodyParsed.kind === 'messages') {
      return rewriteFreeModelResponse_Messages(response, originalModelIdLowerCased);
    }
  }

  return wrapInSafeNextResponse(response);
}
