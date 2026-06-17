import { after, NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { stripRequiredPrefix, toMicrodollars } from '@/lib/utils';
import { extractPromptInfo } from '@/lib/ai-gateway/extractPromptInfo';
import { determineFallbackFeature } from '@/lib/ai-gateway/determineFallbackFeature';
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
} from '@/lib/ai-gateway/providers/openrouter/types';
import { applyProviderSpecificLogic } from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { buildExperimentPromptCapture } from '@/lib/ai-gateway/experiments/persist';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user/server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  isDeadFreeModel,
  isExcludedForFeature,
  isKiloExclusiveFreeModel,
} from '@/lib/ai-gateway/models';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
} from '@/lib/ai-gateway/is-free-model';
import {
  accountForMicrodollarUsage,
  captureProxyError,
  checkOrganizationModelRestrictions,
  dataCollectionRequiredResponse,
  extractFraudAndProjectHeaders,
  featureExclusiveModelResponse,
  invalidPathResponse,
  invalidRequestResponse,
  malformedJsonResponse,
  makeErrorReadable,
  modelDoesNotExistResponse,
  modelNotAllowedResponse,
  extractHeaderAndLimitLength,
  noFreeModelsAvailableResponse,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
  forbiddenFreeModelResponse,
  storeAndPreviousResponseIdIsNotSupported,
  apiKindNotSupportedResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { isDataCollectionExplicitlyDisallowed } from '@/lib/ai-gateway/providers/openrouter/types';
import { rewriteFreeModelResponse } from '@/lib/rewriteModelResponse';
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
import { handleRequestLogging } from '@/lib/ai-gateway/handleRequestLogging';
import {
  classifyAbuse,
  awaitClassifyAbuse,
  cacheRulesEngineAction,
  getCachedRulesEngineAction,
  getQuarantineFreeModel,
  getRulesEngineActionDecision,
  isRulesEngineBlockingAction,
  resolveAbuseClassificationCacheIdentityKey,
  sleepForRulesEngineAction,
} from '@/lib/ai-gateway/abuse-service';
import {
  emitApiMetricsForResponse,
  getToolsAvailable,
  getToolsUsed,
} from '@/lib/ai-gateway/o11y/api-metrics.server';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { isForbiddenFreeModel } from '@/lib/ai-gateway/forbidden-free-models';
import { isCloudflareIP } from '@/lib/cloudflare-ip';
import {
  isKiloAutoModel,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
} from '@/lib/ai-gateway/auto-model';
import { applyResolvedAutoModel } from '@/lib/ai-gateway/auto-model/resolution';
import { fetchEfficientAutoDecision } from '@/lib/ai-gateway/auto-routing-decision';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@/lib/ai-gateway/processUsage.types';
import { logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import {
  getMaxTokens,
  hasMiddleOutTransform,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { redactProviderHints } from '@kilocode/auto-routing-contracts';
import {
  createStreamLifecycleTracker,
  observeEventStream,
  shouldObserveEventStream,
  STREAM_ATTEMPT_HEADER,
} from '@/lib/ai-gateway/o11y/stream-lifecycle.server';

export const maxDuration = 1800;

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
  const authPromise = getUserFromAuth({ adminOnly: false });
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
    return malformedJsonResponse(e);
  }

  if (
    typeof requestBodyParsed.body.model !== 'string' ||
    requestBodyParsed.body.model.trim().length === 0
  ) {
    return modelDoesNotExistResponse();
  }

  if (requestBodyParsed.kind === 'chat_completions' || requestBodyParsed.kind === 'messages') {
    if (!Array.isArray(requestBodyParsed.body.messages)) {
      return invalidRequestResponse();
    }
  }

  if (requestBodyParsed.kind === 'responses') {
    const { input } = requestBodyParsed.body;
    if (input != null && typeof input !== 'string' && !Array.isArray(input)) {
      return invalidRequestResponse();
    }
  }

  const requestedModel = requestBodyParsed.body.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

  // Captured before auto-model resolution and provider transforms mutate the
  // parsed body; efficient routing classifies the original user request.
  const autoRoutingProviderHints = redactProviderHints(requestBodyParsed.body);

  const feature = validateFeatureHeader(
    request.headers.get(FEATURE_HEADER) || determineFallbackFeature(requestBodyParsed)
  );

  const balanceAndSettingsPromise = authPromise.then(res =>
    res.user
      ? getBalanceAndOrgSettings(res.organizationId, res.user)
      : { balance: 0, settings: undefined, plan: undefined }
  );

  // Extract IP early (needed for free model routing fallback and rate limiting)
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();

  const modeHeader = extractHeaderAndLimitLength(request, 'x-kilocode-mode');
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;
  // Per-message id from the kilocode client. Joinable to PostHog
  // `Feedback Submitted.parentMessageID`.
  const clientRequestId = extractHeaderAndLimitLength(request, 'x-kilo-request');
  // Fallback session id used when `x-kilocode-taskid` is absent (e.g.
  // non-kilocode clients). `taskId` still wins when both are present.
  const sessionHeader = extractHeaderAndLimitLength(request, 'x-kilo-session');
  const machineIdHeader = extractHeaderAndLimitLength(request, 'x-kilocode-machineid');

  const logClientDisconnect = () => {
    console.log('AI gateway client disconnected, requested model: %s', requestedModelLowerCased, {
      path,
      elapsed_ms: Math.round(performance.now() - requestStartedAt),
      client_request_id: clientRequestId,
      session_id: taskId ?? sessionHeader,
    });
  };
  if (request.signal.aborted) {
    logClientDisconnect();
  } else {
    request.signal.addEventListener('abort', logClientDisconnect, { once: true });
  }

  let autoModel: string | null = null;
  let classifierCostUsd = 0;
  if (isKiloAutoModel(requestedModelLowerCased)) {
    autoModel = requestedModelLowerCased;
    const efficientDecision =
      requestedModelLowerCased === KILO_AUTO_EFFICIENT_MODEL.id
        ? async () => {
            const { user, authFailedResponse } = await authPromise;
            // The classifier is a paid call on Kilo's own credential. Skip it
            // for unauthenticated requests: kilo-auto/efficient resolves to a
            // paid model, so an unauthenticated caller is rejected downstream
            // regardless, and a null decision simply falls back to balanced.
            // This stops anonymous/abusive traffic from repeatedly spending
            // Kilo-funded classification with no user to attribute it to.
            if (!user || authFailedResponse) return null;
            const result = await fetchEfficientAutoDecision({
              apiKind: requestBodyParsed.kind,
              body: requestBodyParsed.body,
              requestedModel,
              providerHints: autoRoutingProviderHints,
              bodyBytes: Buffer.byteLength(requestBodyText),
              userId: user.id,
              sessionId: taskId ?? sessionHeader,
              machineId: machineIdHeader,
              clientRequestId,
              mode: modeHeader,
              userAgent: extractHeaderAndLimitLength(request, 'user-agent'),
            });
            classifierCostUsd = result?.costUsd ?? 0;
            return result?.decision ?? null;
          }
        : undefined;
    const autoResult = await applyResolvedAutoModel(
      {
        model: requestedModelLowerCased,
        modeHeader,
        featureHeader: feature,
        sessionId: taskId ?? null,
        apiKind: requestBodyParsed.kind,
        clientIp: ipAddress ?? null,
        efficientDecision,
      },
      requestBodyParsed,
      authPromise.then(res => res.user),
      balanceAndSettingsPromise.then(res => res.balance)
    );
    if (autoResult.kind === 'no_free_models_available') {
      return noFreeModelsAvailableResponse();
    }
  }

  let effectiveModelIdLowerCased = requestBodyParsed.body.model.toLowerCase();

  // Reject early (before rate limiting) if the model is exclusive to other features.
  if (isExcludedForFeature(effectiveModelIdLowerCased, feature)) {
    console.warn(
      `Model ${effectiveModelIdLowerCased} is not available for feature ${feature}; rejecting.`
    );
    return featureExclusiveModelResponse(effectiveModelIdLowerCased);
  }
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
  const isRateLimitedFreeModelRequest =
    isKiloExclusiveFreeModel(effectiveModelIdLowerCased) ||
    autoModel === KILO_AUTO_FREE_MODEL.id ||
    (await isPublicIdExperimented(effectiveModelIdLowerCased));
  if (isRateLimitedFreeModelRequest) {
    const rateLimit = await resolveRateLimit(feature, ipAddress, authPromise);
    if (rateLimit instanceof NextResponse) return rateLimit;

    if (!rateLimit.result.allowed) {
      console.warn(
        `Free model rate limit exceeded, ${rateLimit.subject}, model: ${effectiveModelIdLowerCased}, request count: ${rateLimit.result.requestCount}`
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
    if (!(await isFreeModel(effectiveModelIdLowerCased))) {
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
          `model: ${effectiveModelIdLowerCased}, ` +
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

  // Fraud/project headers are pure header parsing; resolve them here so the
  // classifier-overhead billing below can be scheduled before any downstream
  // rejection path runs.
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);

  // Bill the classifier overhead as soon as the cost is known and we have an
  // authenticated user — via after(), so the row is persisted even when the
  // request is rejected downstream (abuse block, provider/api-kind rejection,
  // balance/org checks, upstream 4xx, …). The classifier already ran on Kilo's
  // OpenRouter credential during model resolution, so the cost is owed
  // regardless of how this request ends. Anonymous requests never reach a
  // positive classifier cost (the classifier is skipped for them above), so
  // this only bills real users.
  if (classifierCostUsd > 0 && !isAnonymousContext(user)) {
    const priorMicrodollarUsage = user.microdollars_used;
    after(
      (async () => {
        try {
          const classifierStats: MicrodollarUsageStats = {
            messageId: null,
            model: 'auto-routing/classifier',
            responseContent: '',
            hasError: false,
            inference_provider: null,
            upstream_id: null,
            finish_reason: null,
            latency: null,
            moderation_latency: null,
            generation_time: null,
            streamed: false,
            cancelled: false,
            status_code: 200,
            cost_mUsd: toMicrodollars(classifierCostUsd),
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheHitTokens: 0,
            is_byok: false,
          };
          const classifierContext: MicrodollarUsageContext = {
            api_kind: requestBodyParsed.kind,
            kiloUserId: user.id,
            fraudHeaders,
            organizationId,
            provider: 'openrouter',
            requested_model: KILO_AUTO_EFFICIENT_MODEL.id,
            promptInfo: {
              system_prompt_prefix: '',
              system_prompt_length: 0,
              user_prompt_prefix: '',
            },
            max_tokens: null,
            has_middle_out_transform: null,
            isStreaming: false,
            prior_microdollar_usage: priorMicrodollarUsage,
            // No posthog_distinct_id: this internal overhead row must not emit
            // the generic first_usage / first_microdollar_usage lifecycle
            // events (those are gated on posthog_distinct_id in processUsage).
            // Otherwise the classifier row could race the primary usage row and
            // mis-attribute `auto-routing/classifier` as the user's first model.
            // DB billing is unaffected — it keys on kiloUserId.
            posthog_distinct_id: undefined,
            project_id: projectId,
            status_code: 200,
            editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
            machine_id: machineIdHeader,
            user_byok: false,
            has_tools: false,
            botId,
            tokenSource,
            feature,
            session_id: taskId ?? sessionHeader ?? null,
            mode: modeHeader,
            auto_model: autoModel,
            ttfb_ms: null,
            clientRequestId,
          };
          await logMicrodollarUsage(classifierStats, classifierContext);
        } catch (error) {
          console.error('Failed to bill classifier cost for kilo-auto/efficient', error);
        }
      })()
    );
  }

  if (
    requestBodyParsed.kind === 'responses' &&
    (requestBodyParsed.body.store || requestBodyParsed.body.previous_response_id)
  ) {
    return storeAndPreviousResponseIdIsNotSupported();
  }

  // Log to free_model_usage for rate limiting (at request start, before processing)
  if (isRateLimitedFreeModelRequest) {
    await logFreeModelRequest(
      ipAddress,
      effectiveModelIdLowerCased,
      isAnonymousContext(user) ? undefined : user.id
    );
  }

  // Resolve the initial provider before abuse enforcement because abuse needs
  // provider/BYOK context, and quarantine-3 may later rewrite these values.
  const initialProviderResultForAbuseService = await getProvider({
    requestedModel: effectiveModelIdLowerCased,
    request: requestBodyParsed,
    user,
    organizationId,
    taskId,
    clientIp: ipAddress ?? null,
    machineId: machineIdHeader,
  });
  if (initialProviderResultForAbuseService.kind === 'not-found') {
    // Paused experiment for this public id — return a local model-unavailable
    // response instead of silently falling through to default routing.
    return modelDoesNotExistResponse();
  }
  if (initialProviderResultForAbuseService.kind === 'unavailable') {
    return temporarilyUnavailableResponse();
  }
  let effectiveProviderContext = initialProviderResultForAbuseService;

  if (
    (await hasBestEffortGuessDataCollectionRequirement(effectiveModelIdLowerCased)) &&
    isDataCollectionExplicitlyDisallowed(requestBodyParsed.body.provider)
  ) {
    return dataCollectionRequiredResponse();
  }

  if (!effectiveProviderContext.provider.supportedChatApis.includes(requestBodyParsed.kind)) {
    return apiKindNotSupportedResponse(
      requestBodyParsed.kind,
      effectiveProviderContext.provider.supportedChatApis
    );
  }

  console.debug(`Routing request to ${effectiveProviderContext.provider.id}`);

  // Start classification early, but do not await it unless the last cached
  // rules-engine result says this identity is already under enforcement.
  const classifyPromise = classifyAbuse(request, requestBodyParsed, {
    kiloUserId: user.id,
    organizationId,
    projectId,
    provider: effectiveProviderContext.provider.id,
    isByok: !!effectiveProviderContext.userByok,
    feature,
  });
  const abuseCacheIdentityKey = await resolveAbuseClassificationCacheIdentityKey({
    kiloUserId: user.id,
    fraudHeaders,
  });
  const cachedAction = await getCachedRulesEngineAction(abuseCacheIdentityKey);
  const cachedRulesEngineAction = cachedAction?.action ?? null;
  // Cache-gating keeps normal traffic on the fast path: only identities with a
  // previously blocking/quarantine decision wait for a fresh abuse-service result.
  const shouldBlockOnClassify = isRulesEngineBlockingAction(cachedRulesEngineAction);

  // Large responses may run longer than the 1800s serverless function timeout.
  const requestMaxTokens = getMaxTokens(requestBodyParsed);
  if (requestMaxTokens && requestMaxTokens > MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Max tokens limit exceeded: ${user.id}`, {
      maxTokens: requestMaxTokens,
      bodyText: requestBodyText,
    });
    return temporarilyUnavailableResponse();
  }

  if (
    isDeadFreeModel(effectiveModelIdLowerCased) ||
    (!autoModel && isForbiddenFreeModel(effectiveModelIdLowerCased))
  ) {
    console.warn(`User requested forbidden free model ${effectiveModelIdLowerCased}; rejecting.`);
    return forbiddenFreeModelResponse(fraudHeaders);
  }

  let classifyResult = shouldBlockOnClassify ? await awaitClassifyAbuse(classifyPromise) : null;
  if (classifyResult?.rules_engine) {
    await cacheRulesEngineAction({
      identityKey: classifyResult.context?.identity_key ?? abuseCacheIdentityKey,
      rulesEngine: classifyResult.rules_engine,
    });
  }
  // When a blocking refresh fails or times out, fall back to the cached
  // enforcement decision. Missing/nonblocking cache entries never enforce the
  // fresh result on this request; they only update Redis for the next request.
  const rulesEngineActionForDecision =
    (shouldBlockOnClassify ? classifyResult?.rules_engine?.resolved_action : null) ??
    (shouldBlockOnClassify ? cachedAction?.action : null);
  const rulesEngineDecision = getRulesEngineActionDecision({
    action: rulesEngineActionForDecision,
    userByok: !!effectiveProviderContext.userByok,
    quarantineFreeModel:
      rulesEngineActionForDecision === 'quarantine-3' && !effectiveProviderContext.userByok
        ? await getQuarantineFreeModel(requestBodyParsed.kind)
        : null,
  });
  if (classifyResult) {
    console.log('Abuse classification result:', {
      rules_engine_resolved_action: classifyResult.rules_engine?.resolved_action ?? null,
      rules_engine_sus_score: classifyResult.rules_engine?.sus_score ?? null,
      rules_engine_matched_abuse_rule_ids:
        classifyResult.rules_engine?.matched_abuse_rule_ids ?? [],
      identity_key: classifyResult.context?.identity_key,
      kilo_user_id: user.id,
      requested_model: effectiveModelIdLowerCased,
      rps: classifyResult.context?.requests_per_second,
      request_id: classifyResult.request_id,
    });
  }
  if (rulesEngineDecision.response) {
    return rulesEngineDecision.response;
  }
  let abuseDowngradedFrom: string | null = null;
  if (rulesEngineDecision.modelOverride) {
    // Quarantine-3 rewrites non-BYOK requests to an auto-free candidate, so the
    // provider and derived policy flags must be resolved again for that model.
    abuseDowngradedFrom = effectiveModelIdLowerCased;
    requestBodyParsed.body.model = rulesEngineDecision.modelOverride;
    effectiveModelIdLowerCased = rulesEngineDecision.modelOverride;
    const quarantineProviderResult = await getProvider({
      requestedModel: effectiveModelIdLowerCased,
      request: requestBodyParsed,
      user,
      organizationId,
      taskId,
      clientIp: ipAddress ?? null,
      machineId: machineIdHeader,
    });
    if (quarantineProviderResult.kind === 'not-found') {
      if (rulesEngineDecision.delayMs > 0) {
        await sleepForRulesEngineAction(rulesEngineDecision.delayMs);
      }
      return modelDoesNotExistResponse();
    }
    if (quarantineProviderResult.kind === 'unavailable') {
      if (rulesEngineDecision.delayMs > 0) {
        await sleepForRulesEngineAction(rulesEngineDecision.delayMs);
      }
      return temporarilyUnavailableResponse();
    }

    effectiveProviderContext = quarantineProviderResult;

    console.warn('SECURITY: Abuse quarantine-3 model override applied', {
      kilo_user_id: user.id,
      identity_key: classifyResult?.context?.identity_key ?? abuseCacheIdentityKey,
      abuse_request_id: classifyResult?.request_id ?? null,
      rules_engine_action: rulesEngineDecision.action,
      rules_engine_matched_abuse_rule_ids:
        classifyResult?.rules_engine?.matched_abuse_rule_ids ?? [],
      original_model: abuseDowngradedFrom,
      overridden_model: effectiveModelIdLowerCased,
      original_provider: initialProviderResultForAbuseService.provider.id,
      overridden_provider: effectiveProviderContext.provider.id,
      user_byok: !!effectiveProviderContext.userByok,
      feature,
      project_id: projectId,
    });

    if (!effectiveProviderContext.provider.supportedChatApis.includes(requestBodyParsed.kind)) {
      if (rulesEngineDecision.delayMs > 0) {
        await sleepForRulesEngineAction(rulesEngineDecision.delayMs);
      }
      return apiKindNotSupportedResponse(
        requestBodyParsed.kind,
        effectiveProviderContext.provider.supportedChatApis
      );
    }
  }

  // Extract properties for usage context
  const promptInfo = extractPromptInfo(requestBodyParsed);

  const usageContext: MicrodollarUsageContext = {
    api_kind: requestBodyParsed.kind,
    kiloUserId: user.id,
    provider: effectiveProviderContext.provider.id,
    requested_model: effectiveModelIdLowerCased,
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
    machine_id: machineIdHeader,
    user_byok: !!effectiveProviderContext.userByok,
    has_tools: (requestBodyParsed.body.tools?.length ?? 0) > 0,
    botId,
    tokenSource,
    feature,
    session_id: taskId ?? sessionHeader ?? null,
    mode: modeHeader,
    auto_model: autoModel,
    ttfb_ms: null,
    abuse_delay: rulesEngineDecision.delayMs > 0 ? rulesEngineDecision.delayMs : null,
    abuse_downgraded_from: abuseDowngradedFrom,
    clientRequestId,
  };

  setTag('ui.ai_model', requestBodyParsed.body.model);

  // Skip balance/org checks for anonymous users - they can only use free models
  if (!isAnonymousContext(user) && !effectiveProviderContext.bypassAccessCheck) {
    const { balance, settings, plan } = await balanceAndSettingsPromise;

    if (
      balance <= 0 &&
      !(await isFreeModel(effectiveModelIdLowerCased)) &&
      !effectiveProviderContext.userByok
    ) {
      return await usageLimitExceededResponse(user, balance);
    }

    // Organization model/provider restrictions check
    // Provider/model access policy applies to Enterprise plans; data collection applies to all plans.
    const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
      modelId: effectiveModelIdLowerCased,
      settings,
      organizationPlan: plan,
    });
    if (modelRestrictionError) return modelRestrictionError;

    // Experiment traffic captures prompts to R2 for partner evaluation, which
    // is a form of data collection that the gateway-pinned `data_collection`
    // setting cannot enforce on a direct partner upstream. If the org has
    // explicitly disabled data collection, refuse the experimented public id
    // here rather than routing through and silently capturing prompts.
    if (effectiveProviderContext.experiment && settings?.data_collection === 'deny') {
      return dataCollectionRequiredResponse();
    }

    // Enterprise `provider_allow_list` is enforced via OpenRouter's
    // `body.provider.only` field, which doesn't reach a direct partner
    // upstream. Refuse the experimented public id rather than routing
    // around the org's allow-list.
    if (effectiveProviderContext.experiment && plan === 'enterprise') {
      return modelNotAllowedResponse();
    }

    // Direct experiment upstreams must not have a Vercel/OpenRouter
    // provider config pinned onto them — the partner endpoint is selected
    // by the variant version.
    if (providerConfig && !effectiveProviderContext.experiment) {
      requestBodyParsed.body.provider = providerConfig;
    }
  }

  if (effectiveProviderContext.experiment) {
    usageContext.modelExperimentVariantVersionId =
      effectiveProviderContext.experiment.variantVersionId;
    usageContext.modelExperimentAllocationSubject =
      effectiveProviderContext.experiment.allocationSubject;
    // Cost zeroing for experiment traffic is handled by `isFreeModel`, which
    // returns true for experimented public ids.
  }

  sentryRootSpan()?.setAttribute(
    'openrouter.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const openrouterRequestSpan = startInactiveSpan({
    name: 'upstream-request-start',
    op: 'http.client',
  });

  const extraHeaders: Record<string, string> = {};
  applyProviderSpecificLogic(
    effectiveProviderContext.provider,
    effectiveModelIdLowerCased,
    requestBodyParsed,
    extraHeaders,
    effectiveProviderContext.userByok,
    fraudHeaders,
    user.id,
    taskId ?? null
  );

  const toolsAvailable = getToolsAvailable(requestBodyParsed);
  const toolsUsed = getToolsUsed(requestBodyParsed);

  // Capture the bounded prompt for experimented requests AFTER provider
  // transforms have produced the canonical upstream body. Stored on the
  // usage context so the async `after()` hook can persist it without
  // retaining a reference to the full uncapped body.
  if (effectiveProviderContext.experiment) {
    usageContext.experimentPromptCapture = buildExperimentPromptCapture(requestBodyParsed);
  }

  if (rulesEngineDecision.delayMs > 0) {
    await sleepForRulesEngineAction(rulesEngineDecision.delayMs);
  }

  const observesProvider = effectiveProviderContext.provider.id === 'custom';
  const attemptId = observesProvider ? crypto.randomUUID() : null;
  const response = await upstreamRequest({
    path,
    search: url.search,
    method: request.method,
    body: requestBodyParsed.body,
    extraHeaders,
    provider: effectiveProviderContext.provider,
    signal: request.signal,
  });
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.ttfb_ms = ttfbMs;

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: requestBodyParsed.body.stream === true,
      userByok: !!effectiveProviderContext.userByok,
      mode: modeHeader || undefined,
      provider: effectiveProviderContext.provider.id,
      requestedModel: requestedModelLowerCased,
      resolvedModel: normalizeModelId(effectiveModelIdLowerCased),
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
  if (response.status === 402 && !effectiveProviderContext.userByok) {
    await captureProxyError({
      user,
      request: requestBodyParsed.body,
      response,
      organizationId,
      model: requestBodyParsed.body.model,
      errorMessage: `${effectiveProviderContext.provider.id} returned 402 Payment Required`,
      trackInSentry: true,
    });

    // Return a service unavailable error instead of the 402
    const errorResponse = temporarilyUnavailableResponse();
    if (attemptId) errorResponse.headers.set(STREAM_ATTEMPT_HEADER, attemptId);
    return errorResponse;
  }

  if (response.status >= 400) {
    await captureProxyError({
      user,
      request: requestBodyParsed.body,
      response,
      organizationId,
      model: requestBodyParsed.body.model,
      errorMessage: `${effectiveProviderContext.provider.id} returned error ${response.status}`,
      trackInSentry: response.status >= 500,
    });
  }

  let clonedReponse = response.clone(); // reading from body is side-effectful
  const observesStream = shouldObserveEventStream({
    provider_id: effectiveProviderContext.provider.id,
    status: response.status,
    has_body: response.body !== null,
    content_type: response.headers.get('content-type'),
  });
  const streamTracker =
    observesStream && attemptId
      ? createStreamLifecycleTracker({
          attempt_id: attemptId,
          provider_id: effectiveProviderContext.provider.id,
          api_kind: requestBodyParsed.kind,
        })
      : null;
  if (streamTracker && clonedReponse.body) {
    const owner = clonedReponse;
    const body = clonedReponse.body;
    clonedReponse = new Response(
      observeEventStream(body, outcome => streamTracker.observe('provider', outcome), owner),
      owner
    );
  }

  if (!shouldBlockOnClassify) {
    classifyResult = await awaitClassifyAbuse(classifyPromise);
    if (classifyResult?.rules_engine) {
      await cacheRulesEngineAction({
        identityKey: classifyResult.context?.identity_key ?? abuseCacheIdentityKey,
        rulesEngine: classifyResult.rules_engine,
      });
    }
  }

  if (classifyResult) {
    usageContext.abuse_request_id = classifyResult.request_id;
  }

  accountForMicrodollarUsage(clonedReponse, usageContext, openrouterRequestSpan);

  await handleRequestLogging({
    clonedResponse: response.clone(),
    user: maybeUser,
    organization_id: organizationId || null,
    provider: effectiveProviderContext.provider.id,
    model: effectiveModelIdLowerCased,
    session_id: usageContext.session_id,
    request: requestBodyParsed,
  });

  {
    const errorResponse = await makeErrorReadable({
      providerId: effectiveProviderContext.provider.id,
      requestedModel: effectiveModelIdLowerCased,
      request: requestBodyParsed,
      response,
      isUserByok: !!effectiveProviderContext.userByok,
    });
    if (errorResponse) {
      if (attemptId) errorResponse.headers.set(STREAM_ATTEMPT_HEADER, attemptId);
      return errorResponse;
    }
  }

  const rewrittenResponse = await rewriteFreeModelResponse(
    response,
    effectiveModelIdLowerCased,
    effectiveProviderContext.provider.id,
    requestBodyParsed.kind
  );
  if (rewrittenResponse) {
    // Rewritten streams are excluded because their final bytes cannot be compared to the source.
    if (attemptId) rewrittenResponse.headers.set(STREAM_ATTEMPT_HEADER, attemptId);
    return rewrittenResponse;
  }

  const finalResponse = wrapInSafeNextResponse(response);
  if (attemptId) finalResponse.headers.set(STREAM_ATTEMPT_HEADER, attemptId);
  if (!streamTracker || !finalResponse.body) return finalResponse;

  return new NextResponse(
    observeEventStream(finalResponse.body, outcome => streamTracker.observe('final', outcome)),
    finalResponse
  );
}
