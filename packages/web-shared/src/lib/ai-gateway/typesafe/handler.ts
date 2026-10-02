import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@/lib/ai-gateway/gateway-account-rate-limit';
import {
  getOrganizationProviderPrivacy,
  creditsBlockedResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  modelNotAllowedResponse,
  wrapInSafeNextResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import { generateProviderSpecificHash } from '@/lib/ai-gateway/providerHash';
import { logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { emitGatewayApiMetrics } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { systemOneRequestSchema, systemOneResponseSchema } from '@/lib/ai-gateway/typesafe/schemas';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { toMicrodollars } from '@/lib/microdollars';
import { errorExceptInTest, warnExceptInTest } from '@/lib/utils.server';
import type { ProxyErrorType } from '@/lib/proxy-error-types';
import { getEffectiveProviderPrivacy } from '../provider-privacy';
import { withoutVirtualProvider } from '@/lib/ai-gateway/providers/openrouter/virtual-models';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  getOpenRouterSystemOneModelsFromDatabase,
  resolveOpenRouterModelAlias,
} from '@/lib/ai-gateway/providers/gateway-models-cache';

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
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
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
  if (!(await isSystemOneModel(requestedModel))) {
    return errorResponse(
      `The requested model '${requestedModel}' is not a System One model`,
      'model_not_found',
      404
    );
  }

  const { balance, settings, balanceLimitedByUserAllowance } = await getBalanceAndOrgSettings(
    organizationId,
    user
  );
  if (balance <= 0) {
    return creditsBlockedResponse({ user, balance, organizationId, balanceLimitedByUserAllowance });
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
      modelId: await resolveOpenRouterModelAlias(requestedModel),
      providerLookup: getProviderSlugsForModel,
    });
    if (!decision.allowed) return modelNotAllowedResponse();
    if (decision.eligibleProviderRoutes) {
      const only = withoutVirtualProvider([...decision.eligibleProviderRoutes]);
      if (only.length === 0) return modelNotAllowedResponse();
      providerPolicy = { ...providerPolicy, only };
    }
  }

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

  let response: Response;
  let responseBody: unknown;
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
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    });
    ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (response.status === 402) {
      await response.body?.cancel();
      emitMetrics(response.status, ttfbMs);
      errorExceptInTest('OpenRouter System One balance exhausted');
      return errorResponse('Service temporarily unavailable', 'upstream_error', 503);
    }
    if (!response.ok) {
      emitMetrics(response.status, ttfbMs);
      return wrapInSafeNextResponse(response);
    }
    responseBody = await response.json();
  } catch (error) {
    errorExceptInTest('OpenRouter System One request failed', error);
    return errorResponse('Upstream request failed', 'upstream_error', 502);
  }

  const result = systemOneResponseSchema.safeParse(responseBody);
  emitMetrics(response.status, ttfbMs, result.success ? result.data.provider : undefined);
  if (!result.success) {
    errorExceptInTest('Invalid OpenRouter System One response or missing usage');
    return errorResponse('Invalid upstream response', 'upstream_error', 502);
  }

  const { id, model, provider, usage } = result.data;
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const cost = toMicrodollars(usage.cost);
  after(async () => {
    await logMicrodollarUsage(
      {
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
        cancelled: false,
        status_code: response.status,
        cost_mUsd: cost,
        market_cost: cost,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
        is_byok: false,
      },
      {
        api_kind: 'systemone',
        kiloUserId: user.id,
        provider: 'openrouter',
        requested_model: requestedModel,
        promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
        max_tokens: null,
        has_middle_out_transform: null,
        fraudHeaders,
        isStreaming: false,
        organizationId,
        prior_microdollar_usage: user.microdollars_used,
        posthog_distinct_id: user.google_user_email,
        project_id: projectId,
        status_code: response.status,
        editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
        machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
        user_byok: false,
        has_tools: false,
        botId,
        tokenSource,
        feature: validateFeatureHeader(request.headers.get(FEATURE_HEADER) || ''),
        session_id: extractHeaderAndLimitLength(request, 'X-KiloCode-TaskId'),
        mode: extractHeaderAndLimitLength(request, 'x-kilocode-mode'),
        auto_model: null,
        ttfb_ms: ttfbMs,
      }
    );
  });
  return NextResponse.json(responseBody);
}
