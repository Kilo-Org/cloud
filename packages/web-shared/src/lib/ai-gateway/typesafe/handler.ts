import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  extractHeaderAndLimitLength,
  inferenceProvidersNotAllowedResponse,
  makeErrorReadable,
  providerOptionsNotSupportedResponse,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import {
  dataCollectionPolicyRejection,
  freeModelRateLimitRejection,
  gatewayAccountRateLimitRejection,
  gatewaySettingsRejection,
  gatewayUsageContextBase,
  organizationProviderPreferences,
  paidUsageRejection,
  resolveGatewayCaller,
  resolveOrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { getRouteInferenceRegion } from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import { resolveEmbeddingOrDecisionRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/non-chat-routes';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getNonChatGatewayOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  logMicrodollarUsageAndReportToBouncer,
  mapToUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  computeOpenRouterCosts,
  computeVercelCostFields,
  extractVercelIsByok,
  parseUsageWithRecovery,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import {
  fetchGeneration,
  fetchUpstream,
  UPSTREAM_DURATION_BUDGET_MS,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { emitGatewayApiMetrics } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  systemOneRequestSchema,
  systemOneResponseSchema,
} from '@kilocode/web-shared/lib/ai-gateway/typesafe/schemas';
import { FEATURE_HEADER, validateFeatureHeader } from '@kilocode/web-shared/lib/feature-detection';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { getEffectiveProviderPrivacy } from '../provider-privacy';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getOpenRouterSystemOneModelsFromDatabase,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { systemOneRequestCostBound } from '@kilocode/web-shared/lib/ai-gateway/request-cost-limit';
import { applyUsagePricing } from '@kilocode/web-shared/lib/ai-gateway/usage-cost';
import {
  responseUsageContext,
  rewriteBilledUsageEndpointBody,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.usageEndpoints';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { signedInBouncerRequest } from '@kilocode/web-shared/lib/bouncer/request';
import {
  bareIpLiteral,
  bouncerDecideTier,
  rawClientIp,
} from '@kilocode/web-shared/lib/bouncer/inference';

const VERCEL_TYPESAFE_API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1';

const generationIdSchema = z.object({ id: z.string().min(1) });
const openRouterByokCostSchema = z.object({
  is_byok: z.boolean().nullish(),
  cost_details: z.object({ upstream_inference_cost: z.number().nullish() }).nullish(),
});
const vercelGenerationIdSchema = z.object({
  provider_metadata: z.object({ gateway: z.object({ generationId: z.string().min(1) }) }),
});

/**
 * The Vercel AI Gateway's System One response: TypeSafe's shape with the cost and generation id
 * under `provider_metadata.gateway`. Normalizes to the OpenRouter-compatible body the gateway
 * returns to its callers, with the cost chat and embeddings bill for Vercel (see
 * `computeVercelCostFields`), and reports the cost fields separately for the ledger row.
 */
const vercelSystemOneResponseSchema = z
  .looseObject({
    model: z.string().min(1),
    usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }),
    provider_metadata: z.looseObject({
      gateway: z.looseObject({
        cost: z.string(),
        marketCost: z.string().optional(),
        generationId: z.string().min(1),
        routing: z.looseObject({ finalProvider: z.string().optional() }).optional(),
      }),
    }),
  })
  .transform(({ provider_metadata: { gateway }, ...body }) => {
    const vercelGateway = gateway as NonNullable<VercelProviderMetaData['gateway']>;
    const costFields = computeVercelCostFields(vercelGateway, extractVercelIsByok(vercelGateway));
    return {
      costFields,
      body: {
        ...body,
        id: gateway.generationId,
        provider: gateway.routing?.finalProvider,
        usage: { ...body.usage, cost: costFields.cost_mUsd / 1_000_000 },
      },
    };
  });

function generationIdOf(
  body: z.infer<typeof generationIdSchema> | z.infer<typeof vercelGenerationIdSchema>
) {
  return 'id' in body ? body.id : body.provider_metadata.gateway.generationId;
}

/** A body the gateway could not use may still name the model the provider billed. */
const providerModelSchema = z.object({ model: z.string().trim().min(1) });

function errorResponse(message: string, error_type: ProxyErrorType, status: number) {
  return NextResponse.json({ message, error_type }, { status });
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
  const accountRateLimited = await gatewayAccountRateLimitRejection(request, ipAddress);
  if (accountRateLimited) return accountRateLimited;
  const caller = resolveGatewayCaller(
    await getUserFromAuth({ adminOnly: false, expectedAudience: KILO_GATEWAY_AUDIENCE }),
    { allowAnonymous: false, passThroughAuthFailure: true }
  );
  if (caller.kind === 'rejected') return caller.response;
  const { user, organizationId } = caller;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 'invalid_request', 400);
  }
  // As on chat, refused instead of silently stripped by the schema.
  if (isRecord(body) && body.providerOptions !== undefined) {
    return providerOptionsNotSupportedResponse();
  }
  const parsed = systemOneRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(z.prettifyError(parsed.error), 'invalid_request', 400);
  }
  const { model: requestedModel } = parsed.data;
  const isFree = isFreeModel(requestedModel);
  if (!(await isSystemOneModel(requestedModel))) {
    return errorResponse(
      `The requested model '${requestedModel}' is not a System One model`,
      'model_not_found',
      404
    );
  }
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || '');
  if (isFree) {
    const rateLimited = await freeModelRateLimitRejection({
      request,
      caller,
      model: requestedModel,
      feature,
    });
    if (rateLimited) return rateLimited;
  }
  const resolvedModel = await resolveOpenRouterModelAlias(requestedModel);

  // Unlike `readGatewayBalance`, System One funds free models from usage and
  // blocks them at a zero balance too.
  const account = await getBalanceAndOrgSettings(organizationId, user, readDb, 'usage');
  const { balance, settings, plan, payer } = account;
  const gatewaySettings = await resolveOrganizationGatewaySettings({
    organizationId,
    plan,
    settings,
  });
  // The member's provider routes decide which of the owner's keys may serve the request.
  const organizationDecision = organizationId
    ? (
        await resolveOrganizationMemberModelDecision({
          organizationId,
          kiloUserId: user.id,
          modelId: resolvedModel,
          providerLookup: getProviderSlugsForModel,
          fromDb: readDb,
        })
      ).decision
    : undefined;
  // System One is served by OpenRouter, and by the Vercel AI Gateway when the owner's key or the
  // organization's gateway settings route it there. Models only Vercel serves are not supported.
  const route = await resolveEmbeddingOrDecisionRoute({
    requestedModel: resolvedModel,
    modelType: 'evaluation',
    user,
    organizationId,
    // A denied model leaves no provider allowed, as on chat; the preferences check rejects it.
    allowedProviders:
      organizationDecision && !organizationDecision.allowed
        ? new Set()
        : organizationDecision?.eligibleProviderRoutes,
    openRouterDisabled: gatewaySettings.openRouterDisabled,
  });
  const gatewayRejection = gatewaySettingsRejection(gatewaySettings, route);
  if (gatewayRejection) return gatewayRejection;
  const dataRegion = getRouteInferenceRegion(gatewaySettings, route);
  const isVercelRoute = route.provider.type === 'vercel';
  const userByok = route.userByok;
  const isByok = !!userByok;
  // The owner of a key pays for its requests, so a zero balance does not block them.
  const creditsBlocked = paidUsageRejection({ user, organizationId, account, exempt: isByok });
  if (creditsBlocked) return await creditsBlocked();

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
  if (!isByok && estimatedMaxCostMicrodollars > Math.floor(balance * 1_000_000)) {
    return errorResponse(
      'This request can cost more than the available balance covers. Add credits or send a smaller request.',
      'insufficient_credits',
      402
    );
  }

  const preferences = organizationProviderPreferences({
    decision: organizationDecision,
    settings,
    requestProvider: parsed.data.provider,
  });
  if (preferences.kind === 'rejected') return preferences.response;
  const requestPrivacy = getEffectiveProviderPrivacy(parsed.data.provider);
  const providerPolicy =
    preferences.provider ?? (Object.keys(requestPrivacy).length > 0 ? requestPrivacy : undefined);

  const dataCollectionRejected = await dataCollectionPolicyRejection(resolvedModel, providerPolicy);
  if (dataCollectionRejected) return dataCollectionRejected;

  // Resolved before bouncer decides: a request no eligible provider can serve never reaches the
  // provider, so it owes no decide and no usage row.
  const vercelModelId = isVercelRoute ? await mapModelIdToVercel(resolvedModel) : null;
  const vercelGatewayOptions = vercelModelId
    ? await getNonChatGatewayOptions({
        vercelModelId,
        userByok,
        provider: providerPolicy,
        dataRegion,
      })
    : null;
  if (vercelGatewayOptions?.kind === 'no-eligible-provider') {
    return inferenceProvidersNotAllowedResponse(vercelGatewayOptions.providers);
  }

  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt: startedAt });

  // Resolve bouncer's identity once for this request. System One is always signed
  // in, so its usage row uses a payer-safe IP that drops shared Kilo infrastructure.
  const bouncer = signedInBouncerRequest({
    ip: bareIpLiteral(ipAddress),
    ja4Digest: usageBase.context.fraudHeaders.http_x_vercel_ja4_digest,
    userId: user.id,
    organizationId,
    feature,
  });

  // The one decide for this request, awaited just before the upstream call within its 500 ms
  // budget. Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise = bouncer.decide({
    tier: bouncerDecideTier(organizationId, plan, balance),
    payer,
  });

  const kiloUserId = user.id;
  const { mode } = usageBase.context;
  function emitMetrics(statusCode: number, ttfbMs: number, inferenceProvider?: string | null) {
    emitGatewayApiMetrics({
      kiloUserId,
      organizationId,
      isAnonymous: false,
      isStreaming: false,
      userByok: isByok,
      mode: mode || undefined,
      provider: route.provider.type,
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
  const bouncerUsage = await bouncer.usage(
    {
      occurredAt: new Date(startedAtMs),
      clientAttributed: usageBase.clientAttributed,
      requestedLogprobs: false,
      samples: null,
      // System One input is a typed classification payload, not a conversation,
      // so there is no prompt text to hash (and no raw state leaves the gateway).
      promptSimHash: null,
    },
    payer
  );
  const bouncerRejection = bouncer.apply(bouncerVerdict, bouncerUsage);
  if (bouncerRejection) return bouncerRejection;

  const usageContextOf = (statusCode: number, ttfb: number | null): MicrodollarUsageContext => ({
    ...usageBase.context,
    api_kind: 'systemone',
    provider: route.provider.type,
    requested_model: requestedModel,
    is_free: isFree,
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    isStreaming: false,
    status_code: statusCode,
    user_byok: isByok,
    inference_region: dataRegion,
    has_tools: false,
    feature,
    ttfb_ms: ttfb,
    bouncer: { ...bouncerUsage },
  });

  /**
   * A request that reached the provider but whose cost the gateway cannot read
   * still owes a ledger row and a bouncer event, so its spend stays visible. The
   * row carries no debit: the gateway never charges a cost it did not observe.
   */
  const zeroCostUsageStats = ({
    messageId,
    model = resolvedModel,
    statusCode,
    cancelled,
    ttfb,
  }: {
    messageId: string | null;
    /** The provider's own model id, when the response body named one. */
    model?: string;
    statusCode: number;
    cancelled: boolean;
    ttfb: number | null;
  }): MicrodollarUsageStats => ({
    messageId,
    model,
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
    is_byok: isByok,
  });

  const deferZeroCostUsage = (
    messageId: string | null,
    statusCode: number,
    ttfb: number | null,
    model?: string
  ) => {
    const stats = zeroCostUsageStats({
      messageId,
      model,
      statusCode,
      cancelled: request.signal.aborted,
      ttfb,
    });
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
  const deferReconciledUsage = (stats: MicrodollarUsageStats, context: MicrodollarUsageContext) => {
    after(async () => {
      const generation = stats.messageId
        ? await fetchGeneration(stats.messageId, route.provider)
        : undefined;
      if (!generation) {
        await logMicrodollarUsageAndReportToBouncer(stats, context);
        return;
      }
      const reconciled = mapToUsageStats(generation, '', user.id, route.provider.type);
      const reconciledStats: MicrodollarUsageStats = {
        ...reconciled,
        messageId: reconciled.messageId ?? stats.messageId,
        model: reconciled.model ?? stats.model,
        hasError: true,
        status_code: stats.status_code,
        cancelled: stats.cancelled,
        // The generation lookup carries no latency, so the gateway's own
        // measurement is the one this row reports, as it does for the other rows.
        latency: stats.latency,
        market_cost: reconciled.cost_mUsd,
      };
      // Same pricing the answered path applies: the provider cost stays on the row as
      // `market_cost`, custom pricing bills the generation's tokens, and a free model charges nothing.
      applyUsagePricing(reconciledStats, context, customPricingConfig);
      await logMicrodollarUsageAndReportToBouncer(reconciledStats, context);
    });
  };

  /**
   * A failed upstream call still owes its attempt row. The row reports the first-byte time the
   * gateway measured, which is absent only when no response ever arrived.
   */
  const upstreamFailureResponse = (
    timedOut: boolean,
    measuredTtfbMs: number | null,
    recordUsage = true
  ) => {
    if (recordUsage) {
      deferZeroCostUsage(null, timedOut ? 504 : 502, measuredTtfbMs);
    }
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

  const upstream = await fetchUpstream({
    provider: isVercelRoute
      ? { ...route.provider, apiUrl: VERCEL_TYPESAFE_API_URL }
      : route.provider,
    path: '/systemone',
    method: 'POST',
    body:
      vercelModelId && vercelGatewayOptions
        ? {
            model: vercelModelId,
            state: parsed.data.state,
            questions: parsed.data.questions,
            providerOptions: { gateway: vercelGatewayOptions.gateway },
          }
        : {
            ...parsed.data,
            model: resolvedModel,
            provider: providerPolicy,
            user: generateProviderSpecificHash(user.id, route.provider),
          },
    // No `signal`: the provider's outcome decides what this request costs, and a
    // client that leaves does not undo a generation the provider already started.
    // Only the duration bound stops the call, so a disconnect still reaches the
    // usage record below instead of discarding it.
    vercelRequestId: extractHeaderAndLimitLength(request, 'x-vercel-id'),
    // The route's maxDuration matches chat's, and so does the usage work after the response.
    durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });
  if (upstream.type === 'error') {
    // The URL policy refused the call before the provider generated anything.
    if (!upstream.fetchFailure) return upstream.response;
    // No response arrived, so this request has no first byte to report.
    return upstreamFailureResponse(upstream.fetchFailure.timedOut, null);
  }
  const { response } = upstream;
  const ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (!response.ok) {
    // Only Kilo's own account can run out of balance; an owner's key reports its own errors.
    const kiloBalanceExhausted = response.status === 402 && !isByok;
    if (kiloBalanceExhausted) {
      await response.body?.cancel();
      errorExceptInTest(
        `${isVercelRoute ? 'Vercel AI Gateway' : 'OpenRouter'} System One balance exhausted`
      );
    }
    emitMetrics(response.status, ttfbMs);
    // The row reports the provider's own answer, so it agrees with the metrics
    // and with the ledger of every other upstream error response.
    deferZeroCostUsage(null, response.status, ttfbMs);
    if (kiloBalanceExhausted) {
      return errorResponse('Service temporarily unavailable', 'upstream_error', 503);
    }
    const readableError = await makeErrorReadable({
      provider: route.provider.type,
      requestedModel,
      request: null,
      response,
      userByokProviderIds: userByok?.map(byok => byok.providerId) ?? null,
    });
    return readableError ?? wrapInSafeNextResponse(response);
  }

  let responseBody: unknown;
  let bodyRead = false;
  let answer: z.infer<typeof systemOneResponseSchema> | undefined;
  let vercelCostFields: z.infer<typeof vercelSystemOneResponseSchema>['costFields'] | undefined;
  const context = usageContextOf(response.status, ttfbMs);
  const stats = await parseUsageWithRecovery(response, context, async () => {
    responseBody = await response.json();
    bodyRead = true;
    if (isVercelRoute) {
      const normalized = vercelSystemOneResponseSchema.parse(responseBody);
      answer = systemOneResponseSchema.parse(normalized.body);
      vercelCostFields = normalized.costFields;
    } else {
      answer = systemOneResponseSchema.parse(responseBody);
    }
    const { id, model, provider, usage } = answer;
    return {
      ...zeroCostUsageStats({
        messageId: id,
        model,
        statusCode: response.status,
        cancelled: request.signal.aborted,
        ttfb: ttfbMs,
      }),
      hasError: false,
      inference_provider: provider ?? null,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    };
  });
  emitMetrics(response.status, ttfbMs, stats.inference_provider);
  if (stats.hasError || !answer) {
    const reportedModel = providerModelSchema.safeParse(responseBody);
    const generationId = (isVercelRoute ? vercelGenerationIdSchema : generationIdSchema).safeParse(
      responseBody
    );
    deferReconciledUsage(
      {
        ...stats,
        messageId: generationId.success ? generationIdOf(generationId.data) : stats.messageId,
        model: reportedModel.success ? reportedModel.data.model : resolvedModel,
        latency: ttfbMs,
        streamed: false,
        cancelled: request.signal.aborted,
        market_cost: 0,
        is_byok: isByok,
      },
      context
    );
    if (!bodyRead) return upstreamFailureResponse(false, ttfbMs, false);
    return errorResponse('Invalid upstream response', 'upstream_error', 502);
  }

  if (vercelCostFields) {
    stats.cost_mUsd = vercelCostFields.cost_mUsd;
    stats.nonInferenceCost_mUsd = vercelCostFields.nonInferenceCost_mUsd;
  } else {
    // An owner's OpenRouter key reports only OpenRouter's BYOK fee as `usage.cost`; the inference
    // cost is `cost_details.upstream_inference_cost`, as on chat. Kilo's own account is never BYOK,
    // whatever the body claims.
    const byokCost = isByok ? openRouterByokCostSchema.safeParse(answer.usage) : undefined;
    const costFields = computeOpenRouterCosts(
      { cost: answer.usage.cost, ...(byokCost?.success && byokCost.data) },
      route.provider.type
    );
    stats.cost_mUsd = costFields.cost_mUsd;
    stats.nonInferenceCost_mUsd = costFields.nonInferenceCost_mUsd;
  }
  stats.market_cost = stats.cost_mUsd;
  // Keeps the provider cost as `market_cost`, then applies custom pricing and zeroes a free model.
  applyUsagePricing(stats, context, customPricingConfig);
  after(async () => {
    await logMicrodollarUsageAndReportToBouncer(stats, context);
  });
  // The caller gets the model id it asked for and the cost the ledger row bills, as on chat.
  rewriteBilledUsageEndpointBody(answer, stats, responseUsageContext(context, customPricingConfig));
  return NextResponse.json(answer);
}
