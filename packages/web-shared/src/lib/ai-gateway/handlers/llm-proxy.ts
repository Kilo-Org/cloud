import { randomUUID } from 'node:crypto';
import { type NextResponse as NextResponseType } from 'next/server';
import { after, type NextRequest } from 'next/server';
import { ensureAnthropicUserProfile } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/ensure';
import {
  isAnthropicUserProfileRoute,
  resolveGatewayAnthropicUserProfile,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/gateway';
import { extractPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/extractPromptInfo';
import { determineFallbackFeature } from '@kilocode/web-shared/lib/ai-gateway/determineFallbackFeature';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { BRIEFING_SETTLEMENT_HEADER } from '@kilocode/web-shared/lib/agent-briefing-usage';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { sendUpstreamAttemptWithByokFailover } from '@kilocode/web-shared/lib/ai-gateway/providers/byok-failover';
import type { SendUpstreamAttemptResult } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
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
  unknownModelResponse,
  lastUserPromptText,
  requestedLogprobs,
  requestedSamples,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { type BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { logUnrewrittenResponse } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import { AUTO_DECISION_HEADER } from '@kilocode/auto-routing-contracts';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  getMaxTokens,
  hasMiddleOutTransform,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { redactProviderHints } from '@kilocode/auto-routing-contracts';
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
import { extractRequestParts } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
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
  freeModelRateLimitRejection,
  gatewayAccountRateLimitRejection,
  resolveGatewayCaller,
  resolveBenchmarkCaller,
  type GatewayCaller,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { createAiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
import {
  benchmarkRefusalResponse,
  requestBenchmarkAdmission,
  signedModelViolation,
} from '@kilocode/web-shared/lib/ai-gateway/benchmark-case-admission';
import { recordTerminalNoChargeReceipt } from '@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt';
import { logMicrodollarUsage } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { BenchmarkGatewayAssignment } from '@kilocode/auto-routing-contracts';

/**
 * A benchmark case request arrives from the Worker with a signed assignment instead of a user
 * credential. The gateway never mints or accepts a user token for it: it loads the signed
 * payer/actor row and runs the ordinary admission (membership, allowance, org settings, model
 * policy, provider privacy) as that account.
 *
 * `state.admitted` flips exactly once, immediately before the provider send. Every earlier
 * answer therefore carries no provider call and is a refusal; every later one may have spent
 * money and must never be reassigned from its provider status.
 */
export type BenchmarkCaseContext = {
  assignment: BenchmarkGatewayAssignment;
  state: { admitted: boolean };
};

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
 * The status a benchmark call's terminal zero-charge receipt should carry, or null when the
 * gateway cannot prove the provider was never dialled.
 *
 * A benchmark case reaches `unknown-gateway-model` only from the model-availability check and a
 * `notInvoked` error only from a refusal the provider layer recorded before it opened a
 * connection. Both would otherwise leave the admitted model request with no native row, so the
 * Worker's receipt read would stay `pending` forever and block that payer's next admit. Every
 * other outcome stays pending: the provider may already have billed the call.
 */
export function benchmarkTerminalNoChargeStatus(
  benchmark: BenchmarkCaseContext | undefined,
  attempt: SendUpstreamAttemptResult
): number | null {
  if (!benchmark) return null;
  if (attempt.type === 'unknown-gateway-model') return 404;
  if (attempt.type === 'error' && attempt.notInvoked === true) return attempt.response.status;
  return null;
}

export async function handleLlmProxyRequest(
  request: NextRequest,
  options?: { benchmark?: BenchmarkCaseContext }
): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();
  // Wall-clock start for bouncer's `occurredAt`; the monotonic clock above
  // cannot date the event.
  const requestStartedAtMs = Date.now();
  const benchmark = options?.benchmark;

  const url = new URL(request.url);
  const path = llmProxyPath(url);
  if (!path) return invalidPathResponse();

  const rawIpAddress = rawClientIp(request);
  const countryCode = requestCountryCode(request.headers);

  // A benchmark case request is authenticated by its signed assignment and is bounded by the
  // Worker's per-case concurrency, so it is not subject to the per-account inference cap: its
  // bearer is not a user token and an IP-keyed allowance would count every case as one account.
  if (!benchmark) {
    // Cap the account before this function starts any database work. Every WAF
    // rule in front of this route counts per IP, so an actor rotating addresses
    // buys one allowance per address; this one counts the account itself.
    //
    // The cap has to sit above `getUserFromAuth`, not below it. Auth resolves the
    // account with a read-replica query, so a cap placed after auth still spends a
    // connection on every flooded request. The key comes from the signed token
    // instead, which costs no query.
    const accountRateLimited = await gatewayAccountRateLimitRejection(request, rawIpAddress);
    if (accountRateLimited) return accountRateLimited;
  }

  const requestBodyText = await request.text();
  // Free models also serve anonymous callers, so a missing credential resolves to
  // an anonymous caller here; paid models reject it once the model is known.
  // A benchmark request never mints or accepts a user token: its caller is the
  // signed payer/actor row the Worker named, and the assignment is verified before
  // this function runs.
  const callerPromise: Promise<GatewayCaller> = benchmark
    ? resolveBenchmarkCaller(benchmark.assignment)
    : getUserFromAuth({
        adminOnly: false,
        expectedAudience: KILO_GATEWAY_AUDIENCE,
      }).then(auth =>
        resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: rawIpAddress })
      );
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

  if (benchmark) {
    // The exact signed concrete model, never a routed alias and never a virtual auto model.
    if (signedModelViolation(benchmark.assignment, requestedModel)) {
      return benchmarkRefusalResponse('payer_unavailable', false);
    }
  }

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
      ? readGatewayBalance(caller.user, caller.organizationId, requestedModelLowerCased, {
          // A benchmark case never initiates a purchase for its payer, and it reads the
          // primary: the same payer may have just been debited by an earlier case request.
          noAutoTopUp: Boolean(benchmark),
          fresh: Boolean(benchmark),
        })
      : anonymousBalance
  );
  const organizationGroupContextPromise = callerPromise.then(async caller => {
    if (caller.kind !== 'signed-in' || !caller.organizationId) return null;
    return await getOrganizationGroupPolicyContext({
      organizationId: caller.organizationId,
      subject: { type: 'member', kiloUserId: caller.user.id },
      fromDb: readDb,
    });
  });
  const organizationGroupPolicyPromise = organizationGroupContextPromise.then(
    context => context && evaluateEffectiveModelAccessPolicy(context)
  );
  // Some early returns do not await organization policy. Keep those paths from
  // surfacing policy-context failures as unhandled rejections.
  void organizationGroupPolicyPromise.catch(() => {});

  const headers = readLlmProxyHeaders(request);
  // A benchmark case request's usage id is minted by the Worker and signed into the
  // assignment, so `microdollar_usage.id` is known before the call and a replay cannot
  // double-charge. Every other request keeps a fresh server-side id.
  const usageId = benchmark ? benchmark.assignment.usageId : randomUUID();

  const enkryptAdmission = await Promise.all([callerPromise, balanceAndSettingsPromise]).then(
    ([caller, account]) =>
      admitEnkryptGuardrail(caller, account, () =>
        organizationGroupContextPromise.then(context => context?.groupIds ?? [])
      )
  );
  if (enkryptAdmission.kind === 'rejected') return enkryptAdmission.response;

  // Like the bouncer decide, the guardrail scan overlaps routing work. Its blocking detectors are
  // awaited just before the upstream call; log-only detectors are never awaited. Parts are
  // extracted inside the promise so an extraction failure rejects the guardrail, failing closed.
  const enkryptGuardrail = startEnkryptInputGuardrail(
    Promise.resolve(enkryptAdmission.inputGuardrail).then(
      inputGuardrail =>
        inputGuardrail && {
          ...inputGuardrail,
          sessionId: headers.sessionId,
          microdollarUsageId: usageId,
          // From the verified assignment only: no header can claim benchmark provenance.
          benchmarkCase: Boolean(benchmark),
          apiKind: requestBodyParsed.kind,
          clientRequestId: headers.clientRequestId,
          parts: extractRequestParts(requestBodyParsed),
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
  // Overlaps routing work; a failed lookup only drops the profile header.
  const anthropicUserProfilePromise = callerPromise
    .then(caller =>
      caller.kind === 'signed-in'
        ? resolveGatewayAnthropicUserProfile({
            model: effectiveModelIdLowerCased,
            user: caller.user,
            organizationId: caller.organizationId,
          })
        : null
    )
    .catch((error: unknown) => {
      console.error('Failed to resolve the Anthropic user profile', error);
      return null;
    });
  const customLlm = await findCustomLlm(effectiveModelIdLowerCased);
  const isPrivateCustomLlm = customLlm !== null && !isPublicCustomLlm(customLlm.definition);
  // Anonymous callers cannot use private custom LLMs, so those are never publicly free.
  const isPubliclyFreeModel = !isPrivateCustomLlm && isFreeModel(effectiveModelIdLowerCased);

  // Bouncer takes a bare IP literal. Normalize once here and reuse the value for
  // the report-only decide call and the usage event, which share this request.
  const clientIp = bareIpLiteral(ipAddress);

  if (isPubliclyFreeModel) {
    const freeModelCaller = await callerPromise;
    if (freeModelCaller.kind === 'rejected') return freeModelCaller.response;
    const rateLimited = await freeModelRateLimitRejection({
      request,
      caller: freeModelCaller,
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
  providerMetadataCapture?.captureEnkryptReport(() => enkryptGuardrail.report());
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
    managedRoutesOnly: Boolean(benchmark),
    // Only a benchmark call may rotate: an ordinary request keeps its generic 402.
    markPayerRefusal: benchmark
      ? (reason: 'payment_refused' | 'payer_unavailable') => benchmarkRefusalResponse(reason, false)
      : undefined,
  });
  if (!providerPolicy.ok) return providerPolicy.response;
  const { route, failoverRoutes, isNonTrialEnterprise, dataRegion } = providerPolicy;

  console.debug(`Routing request to ${route.provider.type}`, {
    byokProviderIds: route.userByok?.map(byok => byok.providerId) ?? null,
  });

  const promptInfo = extractPromptInfo(requestBodyParsed);
  const bouncerUsageFields = {
    occurredAt: new Date(requestStartedAtMs),
    clientAttributed: usageBase.clientAttributed,
    requestedLogprobs: requestedLogprobs(requestBodyParsed.body),
    samples: requestedSamples(requestBodyParsed.body),
    // Hash now (about 0.1 ms for the 4 KiB cap), so the raw prompt never rides on the
    // usage context, which reaches Sentry and several helpers.
    promptSimHash: simHash64(lastUserPromptText(requestBodyParsed) ?? ''),
  };
  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    // The signed assignment, not the caller's header, owns the reserved benchmark project
    // namespace. `extractFraudAndProjectHeaders` strips a caller-supplied one, so this is the
    // only writer of a benchmark project id.
    ...(benchmark ? { project_id: benchmark.assignment.projectId } : {}),
    api_kind: requestBodyParsed.kind,
    provider: route.provider.type,
    requested_model: effectiveModelIdLowerCased,
    is_free: route.isFree,
    custom_llm_pricing: route.customLlmPricing ?? customLlm?.definition.pricing ?? null,
    promptInfo,
    max_tokens: getMaxTokens(requestBodyParsed),
    has_middle_out_transform: hasMiddleOutTransform(requestBodyParsed),
    reasoning_setting: extractReasoningSetting(requestBodyParsed.body),
    isStreaming: requestBodyParsed.body.stream === true,
    user_byok: !!route.userByok,
    has_tools: (requestBodyParsed.body.tools?.length ?? 0) > 0,
    feature,
    auto_model: autoModel,
    clientRequestId: headers.clientRequestId,
    usageId,
    providerMetadataCapture,
    bouncer: await (bouncer.kind === 'signed-in'
      ? bouncer.usage(
          bouncerUsageFields,
          balanceAndSettingsPromise.then(({ payer }) => payer)
        )
      : bouncer.usage(bouncerUsageFields)),
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
    usage_id: usageId,
    user: caller.kind === 'signed-in' ? caller.user : null,
    organization_id: organizationId || null,
    session_id: usageContext.session_id,
    vercel_request_id: headers.vercelRequestId,
    request: requestBodyParsed,
    enkrypt: (captureResponse?: boolean) => enkryptGuardrail.requestLogs(captureResponse),
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
      logging: requestLogging,
      error: { guardrail_rejection: guardrailVerdict.action },
    });
    return guardrailRejection;
  }
  const requestCostBalance = requestCostLimit !== null ? await balanceAndSettingsPromise : null;
  const anthropicUserProfile = await anthropicUserProfilePromise;
  if (
    anthropicUserProfile?.create &&
    !anthropicUserProfile.userProfileId &&
    isAnthropicUserProfileRoute(route)
  ) {
    // This request goes out unattributed; later ones carry the stored profile.
    const { subject } = anthropicUserProfile;
    after(() =>
      ensureAnthropicUserProfile(subject, countryCode).then(
        () => undefined,
        (error: unknown) => console.error('Failed to create an Anthropic user profile', error)
      )
    );
  }

  // A benchmark case request makes its one trusted pre-provider check here: the Worker
  // re-reads the case fence, the selected payer and the platform latch. Everything above this
  // line has made no provider call, so a refusal is safe; everything below may spend money.
  if (benchmark) {
    if (requestCostLimit !== null) {
      // Bounded spending needs a strict text-only schema and rejects the tool continuations a
      // benchmark case sends. Refuse instead of silently forwarding an unbounded request.
      return benchmarkRefusalResponse('pre_upstream_refused', false);
    }
    const refusal = await requestBenchmarkAdmission(benchmark.assignment, {
      secret: INTERNAL_API_SECRET ?? '',
    });
    if (refusal) return benchmarkRefusalResponse(refusal.reason, refusal.retryable);
    benchmark.state.admitted = true;
  }

  const {
    attempt,
    providerContext,
    request: sentRequest,
    failoverAttempts,
  } = await sendUpstreamAttemptWithByokFailover(
    {
      providerContext: route,
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
      anthropicUserProfileId: anthropicUserProfile?.userProfileId ?? null,
      costLimit:
        requestCostLimit !== null && requestCostBalance
          ? {
              maximumMicrodollars: requestCostLimit,
              availableBalanceMicrodollars: Math.floor(requestCostBalance.balance * 1_000_000),
            }
          : undefined,
    },
    // A benchmark case never fails over to another credential: the measurement transport is
    // fixed at admission, and a key failover would change it and bill a different account.
    benchmark ? [] : failoverRoutes
  );
  if (failoverAttempts) providerMetadataCapture?.captureByokFailoverAttempts(failoverAttempts);
  const terminalStatus = benchmarkTerminalNoChargeStatus(benchmark, attempt);
  if (terminalStatus !== null) {
    recordTerminalNoChargeReceipt(usageContext, terminalStatus, logMicrodollarUsage, after);
  }
  if (attempt.type === 'unknown-gateway-model') {
    return unknownModelResponse(effectiveModelIdLowerCased);
  }
  if (attempt.type === 'error') return attempt.response;
  usageContext.provider = providerContext.provider.type;
  // A partner route bills its own pricing; the gateway route it fails over to bills the model's.
  usageContext.custom_llm_pricing =
    providerContext.customLlmPricing ?? customLlm?.definition.pricing ?? null;

  const { settings: organizationSettings } = await balanceAndSettingsPromise;
  return await respondToUpstream({
    upstream: attempt,
    request: sentRequest,
    model: effectiveModelIdLowerCased,
    requestedModel: requestedModelLowerCased,
    providerResult: providerContext,
    user,
    organizationId,
    usageContext,
    upstreamSpan: openrouterRequestSpan,
    requestStartedAt,
    briefingSettlementToken: request.headers.get(BRIEFING_SETTLEMENT_HEADER),
    logging: { ...requestLogging, request: sentRequest },
    enkryptOutputScan:
      organizationId && !isAnonymousContext(user)
        ? resolveEnkryptOutputScan(
            {
              sessionId: usageContext.session_id,
              microdollarUsageId: usageId,
              benchmarkCase: Boolean(benchmark),
              organizationId,
              kiloUserId: user.id,
              apiKind: requestBodyParsed.kind,
              clientRequestId: headers.clientRequestId,
            },
            organizationSettings
          )
        : null,
    signal: request.signal,
    keepAliveUntilFirstByte: caller.kind === 'signed-in' && caller.cloudAgentRuntimeProxied,
    captureEnkryptOutputReport: report =>
      providerMetadataCapture?.captureEnkryptOutputReport(report),
  });
}
