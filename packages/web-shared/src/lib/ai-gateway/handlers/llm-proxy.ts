import { randomUUID } from 'node:crypto';
import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { extractPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/extractPromptInfo';
import { determineFallbackFeature } from '@kilocode/web-shared/lib/ai-gateway/determineFallbackFeature';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { BRIEFING_SETTLEMENT_HEADER } from '@kilocode/web-shared/lib/agent-briefing-usage';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { sendUpstreamAttempt } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  findCustomLlm,
  isPublicCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import {
  invalidPathResponse,
  extractReasoningSetting,
  paidModelAuthRequiredResponse,
  anonymousFreeModelLimitResponse,
  accountFreeModelLimitResponse,
  modelDoesNotExistOnOpenRouterResponse,
  vercelOnlyModelUnavailableResponse,
  lastUserPromptText,
  requestedLogprobs,
  requestedSamples,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { isVercelModel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { type BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { logUnrewrittenResponse } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  freeModelRateLimitKey,
  isFreeModelRateLimited,
  type FreeModelRateLimitSubject,
} from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import { AUTO_DECISION_HEADER } from '@kilocode/auto-routing-contracts';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  getMaxTokens,
  hasMiddleOutTransform,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { DEFAULT_BENCHMARK_USER_ID, redactProviderHints } from '@kilocode/auto-routing-contracts';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { evaluateEffectiveModelAccessPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
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
import { admitEnkryptGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/admission';
import { extractRequestSegments } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
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
import { respondToUpstream } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-respond';
import { resolveEnkryptOutputScan } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/output-guardrail';
import {
  gatewayUsageContextBase,
  readGatewayBalance,
  resolveGatewayCaller,
  type GatewayCaller,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { createAiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';

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
 * resolved caller rather than the token's claims, so a revoked token cannot spend
 * its account's allowance: a rejected credential gets the invalid-token
 * response instead.
 */
async function freeModelRateLimitResponse(params: {
  request: NextRequest;
  ipAddress: string;
  callerPromise: Promise<GatewayCaller>;
  model: string;
  feature: string | null;
}): Promise<NextResponseType<unknown> | null> {
  const caller = await params.callerPromise;
  if (caller.kind === 'rejected') return caller.response;
  const subject: FreeModelRateLimitSubject =
    caller.kind === 'signed-in'
      ? { kind: 'account', kiloUserId: caller.user.id }
      : { kind: 'ip', ipAddress: params.ipAddress };

  // The default internal benchmark user is exempt: a run sends every case of
  // every free model it measures, and the anti-abuse limit would otherwise
  // throttle the measurement itself. A benchmark user override is not exempt.
  const isExempt = subject.kind === 'account' && subject.kiloUserId === DEFAULT_BENCHMARK_USER_ID;
  if (isExempt || !(await isFreeModelRateLimited(params.request, subject))) return null;
  console.warn(
    `Model rate limit exceeded, ${freeModelRateLimitKey(subject)}, model: ${params.model}, feature: ${params.feature ?? 'none'}`
  );
  return subject.kind === 'account'
    ? accountFreeModelLimitResponse()
    : anonymousFreeModelLimitResponse();
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
  // Free models also serve anonymous callers, so a missing credential resolves to
  // an anonymous caller here; paid models reject it once the model is known.
  const callerPromise = getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  }).then(auth => resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: rawIpAddress }));
  // Invalid requests return before anything awaits auth. Keep those paths from
  // surfacing auth failures as unhandled rejections.
  void callerPromise.catch(() => {});
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
  const balanceAndSettingsPromise = callerPromise.then(caller =>
    caller.kind === 'signed-in'
      ? readGatewayBalance(caller.user, caller.organizationId, requestedModelLowerCased)
      : anonymousBalance
  );
  const organizationGroupPolicyPromise = callerPromise.then(async caller => {
    if (caller.kind !== 'signed-in' || !caller.organizationId) return null;
    const context = await getOrganizationGroupPolicyContext({
      organizationId: caller.organizationId,
      subject: { type: 'member', kiloUserId: caller.user.id },
      fromDb: readDb,
    });
    return evaluateEffectiveModelAccessPolicy(context);
  });
  // Some early returns do not await organization policy. Keep those paths from
  // surfacing policy-context failures as unhandled rejections.
  void organizationGroupPolicyPromise.catch(() => {});

  const headers = readLlmProxyHeaders(request);
  const usageId = randomUUID();

  const enkryptAdmission = await Promise.all([callerPromise, balanceAndSettingsPromise]).then(
    ([caller, account]) => admitEnkryptGuardrail(caller, account)
  );
  if (enkryptAdmission.kind === 'rejected') return enkryptAdmission.response;

  // Like the bouncer decide, the guardrail scan overlaps routing work. Its blocking detectors are
  // awaited just before the upstream call; log-only detectors are never awaited. Segments are
  // extracted inside the promise so an extraction failure rejects the guardrail, failing closed.
  const enkryptGuardrail = startEnkryptInputGuardrail(
    Promise.resolve(enkryptAdmission.inputGuardrail).then(
      inputGuardrail =>
        inputGuardrail && {
          ...inputGuardrail,
          sessionId: headers.sessionId,
          microdollarUsageId: usageId,
          apiKind: requestBodyParsed.kind,
          clientRequestId: headers.clientRequestId,
          segments: extractRequestSegments(requestBodyParsed, {
            includeToolResults: inputGuardrail.config.scanToolResults,
          }),
        }
    ),
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
    callerPromise,
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
  // Anonymous callers cannot use private custom LLMs, so those are never publicly free.
  const isPubliclyFreeModel = !isPrivateCustomLlm && isFreeModel(effectiveModelIdLowerCased);

  // Bouncer takes a bare IP literal. Normalize once here and reuse the value for
  // the report-only decide call and the usage event, which share this request.
  const clientIp = bareIpLiteral(ipAddress);

  if (isPubliclyFreeModel) {
    const rateLimited = await freeModelRateLimitResponse({
      request,
      ipAddress,
      callerPromise,
      model: effectiveModelIdLowerCased,
      feature,
    });
    if (rateLimited) return rateLimited;
  }

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const caller = await callerPromise;
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  if (caller.kind === 'anonymous' && !isPubliclyFreeModel) return paidModelAuthRequiredResponse();
  const { user } = caller;
  const organizationId = caller.kind === 'signed-in' ? caller.organizationId : undefined;
  const botId = caller.kind === 'signed-in' ? caller.botId : undefined;

  // Resolve the header-derived usage fields once here so decide, usage, and the
  // classifier-overhead billing below share one read.
  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt });
  const { fraudHeaders } = usageBase.context;

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
    billLegacyClassifierCost(modelResolution, {
      ...usageBase.context,
      api_kind: requestBodyParsed.kind,
      requested_model: requestedModelLowerCased,
      feature,
      clientRequestId: headers.clientRequestId,
    });
  }
  if (modelResolution.kind === 'rejected') {
    return autoRoutingFailureResponse(modelResolution.failure, requestedModelLowerCased);
  }
  const autoModel = modelResolution.kind === 'routed' ? modelResolution.autoModel : null;

  const requestCostLimit = request.headers.get('x-kilo-max-cost-microdollars');
  const providerMetadataCapture = createAiProviderMetadataCapture(usageId);
  providerMetadataCapture?.captureEnkryptReport(enkryptGuardrail.report);
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
    providerMetadataCapture,
    effectivePrivacy,
    balanceAndSettingsPromise,
    organizationGroupPolicyPromise,
  });
  if (!providerPolicy.ok) return providerPolicy.response;
  const { providerResult, isNonTrialEnterprise, dataRegion } = providerPolicy;

  console.debug(`Routing request to ${providerResult.provider.type}`, {
    byokProviderIds: providerResult.userByok?.map(byok => byok.providerId) ?? null,
  });

  const promptInfo = extractPromptInfo(requestBodyParsed);
  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    api_kind: requestBodyParsed.kind,
    provider: providerResult.provider.type,
    requested_model: effectiveModelIdLowerCased,
    is_free: providerResult.isFree,
    custom_llm_pricing: customLlm?.definition.pricing ?? null,
    promptInfo,
    max_tokens: getMaxTokens(requestBodyParsed),
    has_middle_out_transform: hasMiddleOutTransform(requestBodyParsed),
    reasoning_setting: extractReasoningSetting(requestBodyParsed.body),
    isStreaming: requestBodyParsed.body.stream === true,
    user_byok: !!providerResult.userByok,
    has_tools: (requestBodyParsed.body.tools?.length ?? 0) > 0,
    feature,
    auto_model: autoModel,
    clientRequestId: headers.clientRequestId,
    usageId,
    providerMetadataCapture,
    bouncer: bouncer.usage({
      occurredAt: new Date(requestStartedAtMs),
      clientAttributed: usageBase.clientAttributed,
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

  // The one decide for this request, bounded by its 500 ms budget. Only an enforced verdict
  // rejects; every other outcome sends the request.
  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;
  const requestLogging = {
    user: caller.kind === 'signed-in' ? caller.user : null,
    organization_id: organizationId || null,
    session_id: usageContext.session_id,
    vercel_request_id: headers.vercelRequestId,
    request: requestBodyParsed,
    enkrypt: enkryptGuardrail.requestLogs,
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
    providerContext: providerResult,
    request: requestBodyParsed,
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
    dataRegion,
    costLimit:
      requestCostLimit !== null && requestCostBalance
        ? {
            maximumMicrodollars: requestCostLimit,
            availableBalanceMicrodollars: Math.floor(requestCostBalance.balance * 1_000_000),
          }
        : undefined,
  });
  if (attempt.type === 'invalid-openrouter-model') {
    return (await isVercelModel(effectiveModelIdLowerCased))
      ? vercelOnlyModelUnavailableResponse(effectiveModelIdLowerCased)
      : modelDoesNotExistOnOpenRouterResponse(effectiveModelIdLowerCased);
  }
  if (attempt.type === 'error') return attempt.response;

  const { settings: organizationSettings } = await balanceAndSettingsPromise;
  return await respondToUpstream({
    upstream: attempt,
    request: requestBodyParsed,
    model: effectiveModelIdLowerCased,
    requestedModel: requestedModelLowerCased,
    providerResult,
    user,
    organizationId,
    usageContext,
    upstreamSpan: openrouterRequestSpan,
    requestStartedAt,
    briefingSettlementToken: request.headers.get(BRIEFING_SETTLEMENT_HEADER),
    logging: requestLogging,
    enkryptOutputScan:
      organizationId && !isAnonymousContext(user)
        ? resolveEnkryptOutputScan(
            {
              sessionId: usageContext.session_id,
              microdollarUsageId: usageId,
              organizationId,
              kiloUserId: user.id,
              apiKind: requestBodyParsed.kind,
              clientRequestId: headers.clientRequestId,
            },
            organizationSettings
          )
        : null,
    signal: request.signal,
    captureEnkryptOutputReport: report =>
      providerMetadataCapture?.captureEnkryptOutputReport(report),
  });
}
