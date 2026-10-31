import { randomUUID } from 'crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import {
  getOrganizationProviderPrivacy,
  creditsBlockedResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  modelNotAllowedResponse,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  logMicrodollarUsageAndReportToBouncer,
  mapToUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { fetchGeneration } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { emitGatewayApiMetrics } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  systemOneRequestSchema,
  systemOneResponseSchema,
} from '@kilocode/web-shared/lib/ai-gateway/typesafe/schemas';
import { FEATURE_HEADER, validateFeatureHeader } from '@kilocode/web-shared/lib/feature-detection';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { getEffectiveProviderPrivacy } from '../provider-privacy';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getOpenRouterSystemOneModelsFromDatabase,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { systemOneRequestCostBound } from '@kilocode/web-shared/lib/ai-gateway/request-cost-limit';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { bouncerAccountId, normalizeJa4 } from '@kilocode/web-shared/lib/bouncer/client';
import {
  bareIpLiteral,
  bouncerDecideTier,
  bouncerRejectionResponse,
  payerSharingIp,
  rawClientIp,
  startBouncerDecide,
} from '@kilocode/web-shared/lib/bouncer/inference';

/**
 * One upstream System One call, from the fetch through the last body byte. The
 * route's maxDuration leaves room for the deferred usage work after it.
 */
const SYSTEM_ONE_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Only a body that carries a generation id can have its cost reconciled. */
const generationIdSchema = z.object({ id: z.string().min(1) });

function errorResponse(message: string, error_type: ProxyErrorType, status: number) {
  return NextResponse.json({ message, error_type }, { status });
}

/**
 * `AbortSignal.timeout` rejects the fetch with its own `TimeoutError` reason, so
 * this tells a duration bound from a provider or transport failure without
 * trusting the error message.
 */
function isUpstreamTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'TimeoutError';
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  return error.cause instanceof DOMException && error.cause.name === 'TimeoutError';
}

async function isSystemOneModel(modelId: string) {
  const systemOneModelIds = await getOpenRouterSystemOneModelsFromDatabase();
  if (systemOneModelIds.size === 0) {
    // OpenRouter's System One endpoint still rejects models it cannot serve.
    warnExceptInTest('[isSystemOneModel] no System One model metadata, assuming id is valid');
    return true;
  }
  return systemOneModelIds.has(modelId);
}

export async function handleSystemOneRequest(request: NextRequest) {
  const startedAt = performance.now();
  const startedAtMs = Date.now();
  const ipAddress = rawClientIp(request);
  if (await isGatewayAccountRateLimited(request, gatewayRateLimitKey(request.headers, ipAddress))) {
    return errorResponse('Rate limit exceeded', 'rate_limit_exceeded', 429);
  }

  const { user, authFailedResponse, organizationId, botId, tokenSource } = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  });
  if (authFailedResponse) return authFailedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 'invalid_request', 400);
  }
  const parsed = systemOneRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(z.prettifyError(parsed.error), 'invalid_request', 400);
  }
  const { model: requestedModel } = parsed.data;
  const isFree = isFreeModelExcludingCustomLlms(requestedModel);
  if (!(await isSystemOneModel(requestedModel))) {
    return errorResponse(
      `The requested model '${requestedModel}' is not a System One model`,
      'model_not_found',
      404
    );
  }
  const resolvedModel = await resolveOpenRouterModelAlias(requestedModel);

  const { balance, settings, plan, balanceLimitedByUserAllowance, payer } =
    await getBalanceAndOrgSettings(organizationId, user, readDb, 'usage');
  if (!canSpendPaidUsage(balance)) {
    return creditsBlockedResponse({ user, balance, organizationId, balanceLimitedByUserAllowance });
  }

  // Admit the request when the balance covers the cost bound: the schema bounds the bytes it can
  // carry, and the bound prices those bytes plus the answer generation at the model's current
  // rates.
  const [catalog, customPricingConfig] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getCustomPricingConfig(),
  ]);
  const metadata = catalog[resolvedModel] ?? catalog[requestedModel];
  const estimatedMaxCostMicrodollars = metadata
    ? systemOneRequestCostBound(metadata, parsed.data, customPricingConfig)
    : null;
  if (estimatedMaxCostMicrodollars === null) {
    errorExceptInTest(
      'System One request cost unavailable',
      metadata ? `unusable pricing for '${resolvedModel}'` : `no metadata for '${resolvedModel}'`
    );
    return errorResponse('Service temporarily unavailable', 'temporarily_unavailable', 503);
  }
  if (estimatedMaxCostMicrodollars > Math.floor(balance * 1_000_000)) {
    return errorResponse(
      'This request can cost more than the available balance covers. Add credits or send a smaller request.',
      'insufficient_credits',
      402
    );
  }

  const providerConfig = getOrganizationProviderPrivacy(settings);
  const effectivePrivacy = getEffectiveProviderPrivacy(
    parsed.data.provider,
    settings?.data_collection
  );
  let providerPolicy =
    Object.keys(effectivePrivacy).length > 0
      ? { ...providerConfig, ...effectivePrivacy }
      : providerConfig;
  if (organizationId) {
    const { decision } = await resolveOrganizationMemberModelDecision({
      organizationId,
      kiloUserId: user.id,
      modelId: resolvedModel,
      providerLookup: getProviderSlugsForModel,
      fromDb: readDb,
    });
    if (!decision.allowed) return modelNotAllowedResponse();
    if (decision.eligibleProviderRoutes) {
      const only = withoutVirtualProvider([...decision.eligibleProviderRoutes]);
      if (only.length === 0) return modelNotAllowedResponse();
      providerPolicy = { ...providerPolicy, only };
    }
  }

  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || '');
  const { fraudHeaders, projectId, xKiloCodeVersion } = extractFraudAndProjectHeaders(request);

  // Resolve bouncer's identity once for this request. System One is always signed
  // in, so its usage row uses a payer-safe IP that drops shared Kilo infrastructure.
  const bouncerIp = bareIpLiteral(ipAddress);
  const bouncerRequestId = randomUUID();

  // The one decide for this request, awaited just before the upstream call within its 500 ms
  // budget. Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise = startBouncerDecide({
    requestId: bouncerRequestId,
    ip: bouncerIp,
    ja4: normalizeJa4(fraudHeaders.http_x_vercel_ja4_digest),
    account: {
      accountId: bouncerAccountId(user.id, organizationId),
      userId: user.id,
      tier: bouncerDecideTier(organizationId, plan, balance),
      payer,
    },
  });

  const kiloUserId = user.id;
  const mode = extractHeaderAndLimitLength(request, 'x-kilocode-mode');
  function emitMetrics(statusCode: number, ttfbMs: number, inferenceProvider?: string | null) {
    emitGatewayApiMetrics({
      kiloUserId,
      organizationId,
      isAnonymous: false,
      isStreaming: false,
      userByok: false,
      mode: mode || undefined,
      provider: OPENROUTER.id,
      inferenceProvider: inferenceProvider || undefined,
      requestedModel,
      resolvedModel: normalizeModelId(requestedModel),
      toolsAvailable: [],
      toolsUsed: [],
      ttfbMs,
      completeRequestMs: Math.max(0, Math.round(performance.now() - startedAt)),
      statusCode,
    });
  }

  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncerRejectionResponse(bouncerVerdict, bouncerRequestId);
  if (bouncerRejection) return bouncerRejection;

  const editorName = extractHeaderAndLimitLength(request, 'x-kilocode-editorname');
  const machineId = extractHeaderAndLimitLength(request, 'x-kilocode-machineid');
  const sessionId = extractHeaderAndLimitLength(request, 'X-KiloCode-TaskId');

  const usageContextOf = (statusCode: number, ttfb: number | null): MicrodollarUsageContext => ({
    api_kind: 'systemone',
    kiloUserId: user.id,
    provider: 'openrouter',
    requested_model: requestedModel,
    is_free: isFree,
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    max_tokens: null,
    has_middle_out_transform: null,
    reasoning_setting: null,
    fraudHeaders,
    isStreaming: false,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: user.google_user_email,
    project_id: projectId,
    status_code: statusCode,
    editor_name: editorName,
    machine_id: machineId,
    user_byok: false,
    has_tools: false,
    botId,
    tokenSource,
    feature,
    session_id: sessionId,
    mode,
    auto_model: null,
    ttfb_ms: ttfb,
    bouncer: {
      requestId: bouncerRequestId,
      occurredAt: new Date(startedAtMs),
      accountId: bouncerAccountId(user.id, organizationId),
      clientIp: payerSharingIp(bouncerIp, feature),
      clientAttributed: feature !== null || Boolean(xKiloCodeVersion),
      requestedLogprobs: false,
      samples: null,
      // System One input is a typed classification payload, not a conversation,
      // so there is no prompt text to hash (and no raw state leaves the gateway).
      promptSimHash: null,
      spendWatch: bouncerVerdict?.spendWatch === true,
    },
  });

  /**
   * A request that reached the provider but whose cost the gateway cannot read
   * still owes a ledger row and a bouncer event, so its spend stays visible. The
   * row carries no debit: the gateway never charges a cost it did not observe.
   */
  const zeroCostUsageStats = (
    messageId: string | null,
    statusCode: number,
    cancelled: boolean,
    ttfb: number | null
  ): MicrodollarUsageStats => ({
    messageId,
    model: resolvedModel,
    responseContent: '',
    hasError: true,
    inference_provider: null,
    upstream_id: null,
    finish_reason: null,
    latency: ttfb,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled,
    status_code: statusCode,
    cost_mUsd: 0,
    market_cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: false,
  });

  const deferZeroCostUsage = (
    messageId: string | null,
    statusCode: number,
    ttfb: number | null
  ) => {
    const stats = zeroCostUsageStats(messageId, statusCode, request.signal.aborted, ttfb);
    const context = usageContextOf(statusCode, ttfb);
    after(async () => {
      await logMicrodollarUsageAndReportToBouncer(stats, context);
    });
  };

  /**
   * The provider answered, so it may already have billed the generation, but the
   * body did not carry a usable cost. Reconcile it through the generation
   * endpoint the rest of the gateway uses for the same purpose.
   */
  const deferReconciledUsage = (generationId: string, ttfb: number) => {
    const cancelled = request.signal.aborted;
    const context = usageContextOf(502, ttfb);
    after(async () => {
      const generation = await fetchGeneration(generationId, OPENROUTER);
      if (!generation) {
        await logMicrodollarUsageAndReportToBouncer(
          zeroCostUsageStats(generationId, 502, cancelled, ttfb),
          context
        );
        return;
      }
      const reconciled = mapToUsageStats(generation, '', user.id, OPENROUTER.id);
      await logMicrodollarUsageAndReportToBouncer(
        {
          ...reconciled,
          hasError: true,
          status_code: 502,
          cancelled,
          // The generation lookup carries no latency, so the gateway's own
          // measurement is the one this row reports, as it does for the other rows.
          latency: ttfb,
          // Same split the answered path records: the provider cost stays on the
          // row as `market_cost`, and a free model charges nothing.
          cost_mUsd: isFree ? 0 : reconciled.cost_mUsd,
          market_cost: reconciled.cost_mUsd,
        },
        context
      );
    });
  };

  /**
   * A failed upstream call still owes its attempt row. The row reports the first-byte time the
   * gateway measured, which is absent only when no response ever arrived.
   */
  const upstreamFailureResponse = (error: unknown, measuredTtfbMs: number | null) => {
    deferZeroCostUsage(null, isUpstreamTimeoutError(error) ? 504 : 502, measuredTtfbMs);
    if (request.signal.aborted) {
      return errorResponse(
        'The client disconnected before the response was sent, so the request was cancelled.',
        'client_disconnect',
        499
      );
    }
    return errorResponse('Upstream request failed', 'upstream_error', 502);
  };

  // Nothing has reached the provider yet, so this request owes no usage row.
  if (request.signal.aborted) {
    return errorResponse(
      'The client disconnected before the response was sent, so the request was cancelled.',
      'client_disconnect',
      499
    );
  }

  let response: Response;
  let ttfbMs: number;
  try {
    response = await fetch(`${OPENROUTER.apiUrl}/systemone`, {
      method: 'POST',
      headers: {
        ...ATTRIBUTION_HEADERS,
        Authorization: `Bearer ${OPENROUTER.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...parsed.data,
        provider: providerPolicy,
        user: generateProviderSpecificHash(user.id, OPENROUTER),
      }),
      // The provider's outcome decides what this request costs, and a client that
      // leaves does not undo a generation the provider already started. Only the
      // duration bound stops the call, so a disconnect still reaches the usage
      // record below instead of discarding it.
      signal: AbortSignal.timeout(SYSTEM_ONE_UPSTREAM_TIMEOUT_MS),
    });
    ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));
  } catch (error) {
    // No response arrived, so this request has no first byte to report.
    errorExceptInTest('OpenRouter System One request failed', error);
    return upstreamFailureResponse(error, null);
  }

  if (!response.ok) {
    if (response.status === 402) {
      await response.body?.cancel();
      errorExceptInTest('OpenRouter System One balance exhausted');
    }
    emitMetrics(response.status, ttfbMs);
    deferZeroCostUsage(null, response.status === 402 ? 503 : response.status, ttfbMs);
    return response.status === 402
      ? errorResponse('Service temporarily unavailable', 'upstream_error', 503)
      : wrapInSafeNextResponse(response);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    // The provider received the request and may have billed it, so this row keeps the
    // first-byte time the gateway measured before the body turned out to be unreadable.
    errorExceptInTest('OpenRouter System One response body was unreadable', error);
    return upstreamFailureResponse(error, ttfbMs);
  }

  const result = systemOneResponseSchema.safeParse(responseBody);
  emitMetrics(response.status, ttfbMs, result.success ? result.data.provider : undefined);
  if (!result.success) {
    errorExceptInTest('Invalid OpenRouter System One response or missing usage');
    const generationId = generationIdSchema.safeParse(responseBody);
    if (generationId.success) deferReconciledUsage(generationId.data.id, ttfbMs);
    else deferZeroCostUsage(null, 502, ttfbMs);
    return errorResponse('Invalid upstream response', 'upstream_error', 502);
  }

  const { id, model, provider, usage } = result.data;
  const cost = toMicrodollars(usage.cost);
  const stats: MicrodollarUsageStats = {
    messageId: id,
    model,
    responseContent: '',
    hasError: false,
    inference_provider: provider ?? null,
    upstream_id: null,
    finish_reason: null,
    latency: ttfbMs,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: request.signal.aborted,
    status_code: response.status,
    cost_mUsd: isFree ? 0 : cost,
    market_cost: cost,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: false,
  };
  const context = usageContextOf(response.status, ttfbMs);
  after(async () => {
    await logMicrodollarUsageAndReportToBouncer(stats, context);
  });
  return NextResponse.json(responseBody);
}
