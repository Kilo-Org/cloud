import { randomUUID } from 'node:crypto';
import { after, NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { extractPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/extractPromptInfo';
import { determineFallbackFeature } from '@kilocode/web-shared/lib/ai-gateway/determineFallbackFeature';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import {
  BRIEFING_SETTLEMENT_HEADER,
  recordBriefingUsage,
} from '@kilocode/web-shared/lib/agent-briefing-usage';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { sendUpstreamAttempt } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import {
  isFreeModel,
  isFreeModelExcludingCustomLlms,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  findCustomLlm,
  isPublicCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import {
  accountForMicrodollarUsage,
  extractFraudAndProjectHeaders,
  invalidPathResponse,
  extractReasoningSetting,
  invalidTokenResponse,
  makeErrorReadable,
  paidModelAuthRequiredResponse,
  anonymousFreeModelLimitResponse,
  accountFreeModelLimitResponse,
  modelDoesNotExistOnOpenRouterResponse,
  lastUserPromptText,
  requestedLogprobs,
  requestedSamples,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import {
  getBalanceAndOrgSettings,
  type BalanceAndOrgSettings,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  rewriteModelResponse,
  logUnrewrittenResponse,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse';
import {
  createAnonymousContext,
  isAnonymousContext,
  type AnonymousUserContext,
} from '@kilocode/web-shared/lib/anonymous';
import {
  freeModelRateLimitKey,
  isFreeModelRateLimited,
  type FreeModelRateLimitSubject,
} from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import { emitApiMetricsForResponse } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { AUTO_DECISION_HEADER } from '@kilocode/auto-routing-contracts';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  getMaxTokens,
  hasMiddleOutTransform,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { DEFAULT_BENCHMARK_USER_ID, redactProviderHints } from '@kilocode/auto-routing-contracts';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { evaluateEffectiveModelAccessPolicy } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import {
  bareIpLiteral,
  bouncerDecideTier,
  rawClientIp,
} from '@kilocode/web-shared/lib/bouncer/inference';
import {
  anonymousBouncerRequest,
  signedInBouncerRequest,
} from '@kilocode/web-shared/lib/bouncer/request';
import { simHash64 } from '@kilocode/web-shared/lib/bouncer/simhash';
import { startEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/input-guardrail';
import { enkryptGuardrailRejectionResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import { resolveEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { extractRequestText } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import {
  parseLlmProxyRequest,
  readLlmProxyHeaders,
  type LlmProxyPath,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-request';
import {
  autoRoutingFailureResponse,
  billLegacyClassifierCost,
  resolveModel,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-model-resolution';
import { resolveProviderAndPolicy } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-provider-policy';

function llmProxyPath(url: URL): LlmProxyPath | null {
  switch (url.pathname) {
    case '/api/v1/chat/completions':
      return '/chat/completions';
    case '/api/v1/responses':
      return '/responses';
    case '/api/v1/messages':
      return '/messages';
    default:
      return null;
  }
}

/**
 * Signed-in callers count per account, anonymous callers per IP. Uses the
 * resolved auth rather than the token's claims, so a revoked token cannot spend
 * its account's allowance: a rejected credential gets the invalid-token
 * response instead. Auth has already resolved by the time free-model requests
 * get here, because balance and settings wait on it.
 */
async function resolveFreeModelRateLimitSubject(
  ipAddress: string,
  authPromise: ReturnType<typeof getUserFromAuth>
): Promise<NextResponseType<unknown> | FreeModelRateLimitSubject> {
  const { user, authFailedResponse, credentialsRejected } = await authPromise;
  if (authFailedResponse && credentialsRejected) {
    return invalidTokenResponse();
  }
  return user && !authFailedResponse
    ? { kind: 'account', kiloUserId: user.id }
    : { kind: 'ip', ipAddress };
}

export async function handleLlmProxyRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();
  // Wall-clock start for bouncer's `occurredAt`; the monotonic clock above
  // cannot date the event.
  const requestStartedAtMs = Date.now();

  const url = new URL(request.url);
  const path = llmProxyPath(url);
  if (!path) return invalidPathResponse();

  const rawIpAddress = rawClientIp(request);
  const countryCode = requestCountryCode(request.headers);

  // Cap the account before this function starts any database work. Every WAF
  // rule in front of this route counts per IP, so an actor rotating addresses
  // buys one allowance per address; this one counts the account itself.
  //
  // The cap has to sit above `getUserFromAuth`, not below it. Auth resolves the
  // account with a read-replica query, so a cap placed after auth still spends a
  // connection on every flooded request. The key comes from the signed token
  // instead, which costs no query.
  const accountKey = gatewayRateLimitKey(request.headers, rawIpAddress);
  if (await isGatewayAccountRateLimited(request, accountKey)) {
    console.warn(`Gateway account rate limit exceeded, user: ${accountKey}`);
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        error_type: ProxyErrorType.rate_limit_exceeded,
        message: 'Too many requests. Please try again later.',
      },
      { status: 429 }
    );
  }

  const requestBodyText = await request.text();
  const authPromise = getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  });
  debugSaveProxyRequest(requestBodyText);
  const parsed = parseLlmProxyRequest(path, requestBodyText, rawIpAddress);
  if (!parsed.ok) return parsed.response;
  const { request: requestBodyParsed, requestPrivacy, ipAddress } = parsed;
  const requestProvider = requestBodyParsed.body.provider;
  const requestedModel = requestBodyParsed.body.model;
  const requestedModelLowerCased = requestedModel.toLowerCase();

  const feature = validateFeatureHeader(
    request.headers.get(FEATURE_HEADER) ||
      determineFallbackFeature(requestBodyParsed, request.headers.get('user-agent'))
  );

  // An unauthenticated caller has no balance, allowance, or payer. Type it as
  // the full read result so the union does not hide those optional fields.
  const anonymousBalance: BalanceAndOrgSettings = {
    balance: 0,
    settings: undefined,
    plan: undefined,
  };
  const balanceAndSettingsPromise = authPromise.then(async res =>
    res.user
      ? getBalanceAndOrgSettings(
          res.organizationId,
          res.user,
          readDb,
          (await isFreeModel(requestedModelLowerCased)) ? undefined : 'usage'
        )
      : anonymousBalance
  );
  const organizationGroupPolicyPromise = authPromise.then(async auth => {
    if (!auth.organizationId || !auth.user || auth.authFailedResponse) return null;
    const context = await getOrganizationGroupPolicyContext({
      organizationId: auth.organizationId,
      subject: { type: 'member', kiloUserId: auth.user.id },
      fromDb: readDb,
    });
    return evaluateEffectiveModelAccessPolicy(context);
  });
  // Some early returns do not await organization policy. Keep those paths from
  // surfacing policy-context failures as unhandled rejections.
  void organizationGroupPolicyPromise.catch(() => {});

  const headers = readLlmProxyHeaders(request);

  // Like the bouncer decide, the organization's guardrail scan overlaps auth, balance, and routing
  // work. Its blocking detectors are awaited just before the upstream call; log-only detectors are
  // never awaited.
  const enkryptGuardrail = startEnkryptInputGuardrail(
    Promise.all([authPromise, balanceAndSettingsPromise]).then(([auth, { settings }]) => {
      if (!auth.user || auth.authFailedResponse || !auth.organizationId) return null;
      const config = resolveEnkryptInputGuardrail(auth.organizationId, settings);
      if (!config) return null;
      return {
        sessionId: headers.sessionId,
        organizationId: auth.organizationId,
        kiloUserId: auth.user.id,
        apiKind: requestBodyParsed.kind,
        clientRequestId: headers.clientRequestId,
        text: extractRequestText(requestBodyParsed, {
          includeToolResults: config.scanToolResults,
        }),
        config,
      };
    }),
    request.signal
  );

  const logClientDisconnect = () => {
    // The request signal is forwarded to the upstream fetch and to the response
    // stream reader, so this disconnect also aborts them. Any abort/cancellation
    // logged for this request after this line is a consequence of the client
    // going away, not an upstream provider failure.
    console.log(
      'AI gateway client disconnected (aborting in-flight upstream work for this request), requested model: %s',
      requestedModelLowerCased,
      {
        path,
        elapsed_ms: Math.round(performance.now() - requestStartedAt),
        client_request_id: headers.clientRequestId,
        session_id: headers.sessionId,
        vercel_request_id: headers.vercelRequestId,
      }
    );
  };
  if (request.signal.aborted) {
    logClientDisconnect();
  } else {
    request.signal.addEventListener('abort', logClientDisconnect, { once: true });
  }

  const { settings: privacySettings } = await balanceAndSettingsPromise;
  const effectivePrivacy = getEffectiveProviderPrivacy(
    requestPrivacy,
    privacySettings?.data_collection
  );
  if (Object.keys(effectivePrivacy).length > 0) {
    requestBodyParsed.body.provider = { ...requestProvider, ...effectivePrivacy };
  }

  // Snapshot normalized privacy before model-specific provider transforms.
  const autoRoutingProviderHints = redactProviderHints(requestBodyParsed.body);

  const modelResolution = await resolveModel({
    request: requestBodyParsed,
    requestBodyText,
    autoDecisionToken: request.headers.get(AUTO_DECISION_HEADER),
    ipAddress,
    headers,
    providerHints: autoRoutingProviderHints,
    effectivePrivacy,
    authPromise,
    balanceAndSettingsPromise,
    organizationGroupPolicyPromise,
  });
  // An unavailable router yields to the caller's auth failure and still owes classifier cost, so
  // it is answered after admission.
  if (modelResolution.kind === 'rejected' && modelResolution.failure.kind !== 'unavailable') {
    return autoRoutingFailureResponse(modelResolution.failure, requestedModelLowerCased);
  }

  const effectiveModelIdLowerCased = requestBodyParsed.body.model.toLowerCase();
  const customLlm = await findCustomLlm(effectiveModelIdLowerCased);
  const isPrivateCustomLlm = customLlm !== null && !isPublicCustomLlm(customLlm.definition);
  // A public custom LLM owns its id, so it is publicly free exactly when it sets
  // no pricing. Anonymous callers cannot use private custom LLMs, so for them a
  // private custom LLM id must behave exactly like an unknown id.
  const isPubliclyFreeModel =
    customLlm !== null && !isPrivateCustomLlm
      ? !customLlm.definition.pricing
      : isFreeModelExcludingCustomLlms(effectiveModelIdLowerCased);

  // Bouncer takes a bare IP literal. Normalize once here and reuse the value for
  // the report-only decide call and the usage event, which share this request.
  const clientIp = bareIpLiteral(ipAddress);

  if (isPubliclyFreeModel) {
    const rateLimitSubject = await resolveFreeModelRateLimitSubject(ipAddress, authPromise);
    if (rateLimitSubject instanceof NextResponse) return rateLimitSubject;

    // Private custom LLMs are exempt for signed-in callers, even when their id
    // matches a free-model pattern. So is the default internal benchmark user: a run
    // sends every case of every free model it measures, and the anti-abuse limit
    // would otherwise throttle the measurement itself. A benchmark user override is
    // not exempt.
    const isExempt =
      rateLimitSubject.kind === 'account' &&
      (isPrivateCustomLlm || rateLimitSubject.kiloUserId === DEFAULT_BENCHMARK_USER_ID);
    if (!isExempt && (await isFreeModelRateLimited(request, rateLimitSubject))) {
      console.warn(
        `Model rate limit exceeded, ${freeModelRateLimitKey(rateLimitSubject)}, model: ${effectiveModelIdLowerCased}, feature: ${feature ?? 'none'}`
      );
      return rateLimitSubject.kind === 'account'
        ? accountFreeModelLimitResponse()
        : anonymousFreeModelLimitResponse();
    }
  }

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    credentialsRejected,
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
    // A caller that presented a credential we could not verify is not the same
    // as a caller that presented none. Answering for it as anonymous would
    // silently drop its account, organization, BYOK keys and credits, and would
    // hide from the client that its stored token is broken. Fail the request so
    // the client re-authenticates.
    if (credentialsRejected) {
      return invalidTokenResponse();
    }

    if (!isPubliclyFreeModel) {
      return paidModelAuthRequiredResponse();
    }

    // Anonymous access for free model (rate-limited above when configured)
    user = createAnonymousContext(ipAddress);
    organizationId = undefined;
    botId = undefined;
    tokenSource = undefined;
  } else {
    user = maybeUser;
  }

  // Fraud/project headers are pure header parsing; resolve them once here so
  // decide, usage, and the classifier-overhead billing below share one read.
  const { fraudHeaders, projectId, xKiloCodeVersion } = extractFraudAndProjectHeaders(request);

  // Start the one decide alongside balance and provider work; it is awaited just before the
  // upstream call. The event id is generated server-side so decide and usage share one identity
  // for this request.
  const ja4Digest = fraudHeaders.http_x_vercel_ja4_digest;
  const bouncer = isAnonymousContext(user)
    ? anonymousBouncerRequest({ ip: clientIp, ja4Digest })
    : signedInBouncerRequest({
        ip: clientIp,
        ja4Digest,
        userId: user.id,
        organizationId,
        feature,
      });
  const bouncerVerdictPromise =
    bouncer.kind === 'signed-in'
      ? bouncer.decide(
          balanceAndSettingsPromise.then(({ balance, plan, payer }) => ({
            tier: bouncerDecideTier(organizationId, plan, balance),
            payer,
          }))
        )
      : bouncer.decide();

  if (!isAnonymousContext(user)) {
    billLegacyClassifierCost({
      resolution: modelResolution,
      user,
      usage: {
        api_kind: requestBodyParsed.kind,
        fraudHeaders,
        organizationId,
        requested_model: requestedModelLowerCased,
        project_id: projectId,
        botId,
        tokenSource,
        feature,
      },
      headers,
    });
  }
  if (modelResolution.kind === 'rejected') {
    return autoRoutingFailureResponse(modelResolution.failure, requestedModelLowerCased);
  }
  const autoModel = modelResolution.kind === 'routed' ? modelResolution.autoModel : null;

  const requestCostLimit = request.headers.get('x-kilo-max-cost-microdollars');
  const usageId = randomUUID();
  const providerPolicy = await resolveProviderAndPolicy({
    request: requestBodyParsed,
    model: effectiveModelIdLowerCased,
    requestProvider,
    customLlm,
    modelResolution,
    user,
    organizationId,
    botId,
    countryCode,
    boundedSpending: requestCostLimit !== null,
    usageId,
    effectivePrivacy,
    balanceAndSettingsPromise,
    organizationGroupPolicyPromise,
  });
  if (!providerPolicy.ok) return providerPolicy.response;
  const { providerResult, isNonTrialEnterprise } = providerPolicy;

  console.debug(`Routing request to ${providerResult.provider.type}`, {
    byokProviderIds: providerResult.userByok?.map(byok => byok.providerId) ?? null,
  });

  const promptInfo = extractPromptInfo(requestBodyParsed);
  const usageContext: MicrodollarUsageContext = {
    api_kind: requestBodyParsed.kind,
    kiloUserId: user.id,
    provider: providerResult.provider.type,
    requested_model: effectiveModelIdLowerCased,
    is_free: providerResult.isFree,
    custom_llm_pricing: customLlm?.definition.pricing ?? null,
    promptInfo,
    max_tokens: getMaxTokens(requestBodyParsed),
    has_middle_out_transform: hasMiddleOutTransform(requestBodyParsed),
    reasoning_setting: extractReasoningSetting(requestBodyParsed.body),
    fraudHeaders,
    isStreaming: requestBodyParsed.body.stream === true,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: headers.editorName,
    machine_id: headers.machineId,
    user_byok: !!providerResult.userByok,
    has_tools: (requestBodyParsed.body.tools?.length ?? 0) > 0,
    botId,
    tokenSource,
    feature,
    session_id: headers.sessionId,
    mode: headers.mode,
    auto_model: autoModel,
    ttfb_ms: null,
    requestStartedAt,
    clientRequestId: headers.clientRequestId,
    usageId,
    bouncer: bouncer.usage({
      occurredAt: new Date(requestStartedAtMs),
      clientAttributed: feature !== null || Boolean(xKiloCodeVersion),
      requestedLogprobs: requestedLogprobs(requestBodyParsed.body),
      samples: requestedSamples(requestBodyParsed.body),
      // Hash now (about 0.1 ms for the 4 KiB cap), so the raw prompt never rides on the
      // usage context, which reaches Sentry and several helpers.
      promptSimHash: simHash64(lastUserPromptText(requestBodyParsed) ?? ''),
    }),
  };

  setTag('ui.ai_model', requestBodyParsed.body.model);

  sentryRootSpan()?.setAttribute(
    'openrouter.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const openrouterRequestSpan = startInactiveSpan({
    name: 'upstream-request-start',
    op: 'http.client',
  });

  const upstreamAttemptOptions = {
    requestedModel: effectiveModelIdLowerCased,
    fraudHeaders,
    userId: user.id,
    organizationId: organizationId ?? null,
    sessionId: headers.sessionId,
    taskId: headers.taskId,
    isNonTrialEnterprise,
    search: url.search,
    method: request.method,
    signal: request.signal,
    vercelRequestId: headers.vercelRequestId,
  };

  // The one decide for this request, bounded by its 500 ms budget. Only an enforced verdict
  // rejects; every other outcome sends the request.
  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;
  const requestLogging = {
    user: maybeUser,
    organization_id: organizationId || null,
    session_id: usageContext.session_id,
    vercel_request_id: headers.vercelRequestId,
    request: requestBodyParsed,
  };
  const guardrailVerdict = await enkryptGuardrail.awaitVerdict();
  const guardrailRejection = enkryptGuardrailRejectionResponse(
    requestBodyParsed.kind,
    guardrailVerdict
  );
  if (guardrailRejection) {
    // The disconnect was already logged; nobody reads this rejection.
    if (request.signal.aborted) return guardrailRejection;
    await logUnrewrittenResponse({
      response: guardrailRejection.clone(),
      model: effectiveModelIdLowerCased,
      providerId: providerResult.provider.type,
      logging: requestLogging,
      error: { guardrail_rejection: guardrailVerdict.action },
    });
    return guardrailRejection;
  }
  const requestCostBalance = requestCostLimit !== null ? await balanceAndSettingsPromise : null;

  const attempt = await sendUpstreamAttempt({
    ...upstreamAttemptOptions,
    providerContext: providerResult,
    request: requestBodyParsed,
    costLimit:
      requestCostLimit !== null && requestCostBalance
        ? {
            maximumMicrodollars: requestCostLimit,
            availableBalanceMicrodollars: Math.floor(requestCostBalance.balance * 1_000_000),
          }
        : undefined,
  });
  if (attempt.type === 'invalid-openrouter-model') {
    return modelDoesNotExistOnOpenRouterResponse(effectiveModelIdLowerCased);
  }
  if (attempt.type === 'error') return attempt.response;

  const { response, toolsAvailable, toolsUsed } = attempt;
  const finalUpstreamModel = requestBodyParsed.body.model ?? effectiveModelIdLowerCased;
  logExceptInTest(
    'upstream response status: %s, x-vercel-id: %s, session_id: %s',
    response.status,
    response.headers.get('x-vercel-id') || '<none>',
    usageContext.session_id || '<none>'
  );

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: requestBodyParsed.body.stream === true,
      userByok: !!providerResult.userByok,
      mode: headers.mode || undefined,
      provider: providerResult.provider.type,
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
  const userByokProviderIds =
    providerResult.userByok === null ? null : providerResult.userByok.map(byok => byok.providerId);

  const upstreamErrorResponse = await applyUpstreamErrorPolicy({
    response,
    providerId: providerResult.provider.type,
    isUserByok: !!providerResult.userByok,
    user,
    request: requestBodyParsed.body,
    organizationId,
    model: finalUpstreamModel,
    gatewayModel: effectiveModelIdLowerCased,
    byokProviderIds: userByokProviderIds,
  });
  if (upstreamErrorResponse) return upstreamErrorResponse;

  const clonedReponse = response.clone(); // reading from body is side-effectful

  const accounting = accountForMicrodollarUsage(
    clonedReponse,
    usageContext,
    openrouterRequestSpan,
    providerResult.provider
  );
  const settlementToken = request.headers.get(BRIEFING_SETTLEMENT_HEADER);
  if (
    settlementToken &&
    !isAnonymousContext(user) &&
    !usageContext.isStreaming &&
    autoModel === null &&
    usageContext.session_id?.startsWith('agent-briefing:') &&
    headers.clientRequestId === usageContext.session_id
  ) {
    const generationId = usageContext.session_id;
    after(
      accounting
        .then(usage =>
          recordBriefingUsage({
            kiloUserId: user.id,
            organizationId,
            generationId,
            settlementToken,
            usage,
          })
        )
        .catch(() => {
          errorExceptInTest('Briefing accounting receipt could not be stored');
        })
    );
  }

  {
    const errorResponse = await makeErrorReadable({
      provider: providerResult.provider.type,
      requestedModel: effectiveModelIdLowerCased,
      request: requestBodyParsed,
      response,
      userByokProviderIds,
    });
    if (errorResponse) {
      await logUnrewrittenResponse({
        response,
        model: effectiveModelIdLowerCased,
        providerId: providerResult.provider.type,
        logging: requestLogging,
        error: null,
      });
      return errorResponse;
    }
  }

  return await rewriteModelResponse({
    response,
    model: effectiveModelIdLowerCased,
    providerId: providerResult.provider.type,
    kind: requestBodyParsed.kind,
    isFree: usageContext.is_free,
    userByok: usageContext.user_byok,
    customLlmPricing: usageContext.custom_llm_pricing,
    logging: requestLogging,
    responseTransforms: providerResult.provider.responseTransforms,
  });
}
