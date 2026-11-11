import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { getEmbeddingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  countAndStoreEmbeddingUsage,
  extractEmbeddingPromptInfo,
  invalidRequestResponse,
  malformedJsonResponse,
  modelDoesNotExistResponse,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import type { BalancePayer } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  getEffectiveProviderPrivacy,
  providerPreferencesSchema,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { isAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  gatewayUsageContextBase,
  organizationProviderPreferences,
  paidUsageRejection,
  readGatewayBalance,
  resolveGatewayCaller,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  bareIpLiteral,
  bouncerDecideTier,
  rawClientIp,
} from '@kilocode/web-shared/lib/bouncer/inference';
import {
  anonymousBouncerRequest,
  signedInBouncerRequest,
} from '@kilocode/web-shared/lib/bouncer/request';
import {
  emitApiMetricsForResponse,
  emitGatewayApiMetrics,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  buildUpstreamBody,
  type EmbeddingProxyRequest,
  validateEmbeddingDimensions,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/embedding-request';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProviderConfigForUserByok } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

async function embeddingProxyRequest(params: {
  body: Record<string, unknown>;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const { body, provider, signal } = params;
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  // OpenRouter needs these identification headers (same as upstreamRequest)
  if (provider.type === 'openrouter' || provider.type === 'vercel') {
    for (const [key, value] of Object.entries(ATTRIBUTION_HEADERS)) {
      headers.set(key, value);
    }
  }

  const targetUrl = `${provider.apiUrl}/embeddings`;

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const timeoutSignal = AbortSignal.timeout(TEN_MINUTES_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
}

export async function handleEmbeddingsRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();

  // Parse body first to check model before auth (needed for anonymous access)
  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  let requestBodyParsed: EmbeddingProxyRequest;
  try {
    requestBodyParsed = JSON.parse(requestBodyText) as EmbeddingProxyRequest;
  } catch (e) {
    return malformedJsonResponse(e);
  }

  if (typeof requestBodyParsed.model !== 'string' || requestBodyParsed.model.trim().length === 0) {
    return modelDoesNotExistResponse();
  }

  if (requestBodyParsed.input == null) {
    return invalidRequestResponse();
  }

  const requestPrivacy = providerPreferencesSchema.optional().safeParse(requestBodyParsed.provider);
  if (!requestPrivacy.success) return invalidRequestResponse();

  const requestedModel = requestBodyParsed.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

  const ipAddress = rawClientIp(request);
  if (!ipAddress) {
    return NextResponse.json(
      {
        error: 'Unable to determine client IP',
        error_type: ProxyErrorType.missing_client_ip,
      },
      { status: 400 }
    );
  }

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const caller = resolveGatewayCaller(
    await getUserFromAuth({ adminOnly: false, expectedAudience: KILO_GATEWAY_AUDIENCE }),
    { allowAnonymous: isFreeModel(requestedModelLowerCased), ipAddress }
  );
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  const { user } = caller;
  const organizationId = caller.kind === 'signed-in' ? caller.organizationId : undefined;

  // Custom LLMs are served only through chat routes; never forward their ids elsewhere.
  if (await isCustomLlm(requestedModelLowerCased)) {
    return modelDoesNotExistResponse();
  }

  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt });

  const organizationDecision =
    !isAnonymousContext(user) && organizationId
      ? (
          await resolveOrganizationMemberModelDecision({
            organizationId,
            kiloUserId: user.id,
            modelId: requestedModelLowerCased,
            fromDb: readDb,
          })
        ).decision
      : undefined;

  const { provider, userByok, isFree } = await getEmbeddingProvider(
    requestedModelLowerCased,
    user,
    organizationId,
    organizationDecision?.eligibleProviderRoutes
  );

  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || 'embeddings');

  const bouncerIp = bareIpLiteral(ipAddress);
  const ja4Digest = usageBase.context.fraudHeaders.http_x_vercel_ja4_digest;
  const bouncer = isAnonymousContext(user)
    ? anonymousBouncerRequest({ ip: bouncerIp, ja4Digest })
    : signedInBouncerRequest({
        ip: bouncerIp,
        ja4Digest,
        userId: user.id,
        organizationId,
        feature,
      });

  // Build usage context
  const promptInfo = extractEmbeddingPromptInfo(requestBodyParsed);

  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    api_kind: 'embeddings',
    provider: provider.type,
    requested_model: requestedModelLowerCased,
    is_free: isFree,
    promptInfo,
    isStreaming: false,
    user_byok: !!userByok,
    has_tools: false,
    feature,
    bouncer: bouncer.usage({
      occurredAt: new Date(requestStartedAtMs),
      clientAttributed: usageBase.clientAttributed,
      requestedLogprobs: false,
      samples: null,
      // Embedding input is not read by any bouncer rule, so no hash is computed.
      promptSimHash: null,
    }),
  };

  setTag('ui.ai_model', requestBodyParsed.model);

  let organizationDataCollection: OrganizationSettings['data_collection'];
  let accountBalance = 0;
  let accountPlan: OrganizationPlan | undefined;
  let accountPayer: BalancePayer | undefined;

  // Skip balance/org checks for anonymous users — they can only use free models
  if (!isAnonymousContext(user)) {
    const account = await readGatewayBalance(user, organizationId, requestedModelLowerCased);
    const { balance, settings, plan, payer } = account;
    accountBalance = balance;
    accountPlan = plan;
    accountPayer = payer;
    organizationDataCollection = settings?.data_collection;

    const creditsBlocked = paidUsageRejection({
      user,
      organizationId,
      account,
      exempt: usageContext.is_free || !!userByok,
    });
    if (creditsBlocked) return await creditsBlocked();

    const preferences = organizationProviderPreferences({
      decision: organizationDecision,
      settings,
      requestProvider: requestPrivacy.data,
    });
    if (preferences.kind === 'rejected') return preferences.response;
    if (preferences.provider) requestBodyParsed.provider = preferences.provider;
  }

  sentryRootSpan()?.setAttribute(
    'embedding.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const dimensionError = validateEmbeddingDimensions(requestBodyParsed, requestedModelLowerCased);
  if (dimensionError) {
    return NextResponse.json(
      {
        error: {
          message: dimensionError,
          type: 'invalid_request_error',
          param: 'dimensions',
          code: null,
        },
      },
      { status: 400 }
    );
  }

  // The one decide for this request, awaited just before the upstream call within its 500 ms
  // budget. Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise =
    bouncer.kind === 'signed-in'
      ? bouncer.decide({
          tier: bouncerDecideTier(organizationId, accountPlan, accountBalance),
          payer: accountPayer,
        })
      : bouncer.decide();

  const embeddingRequestSpan = startInactiveSpan({
    name: 'embedding-request-start',
    op: 'http.client',
  });

  // Always set the hashed identifier for upstream abuse attribution / safety scoping
  requestBodyParsed.safety_identifier = generateProviderSpecificHash(user.id, provider);

  // BYOK: for Vercel gateway, pass the user's key via providerOptions (same as chat completions).
  const effectiveProvider = provider;

  if (userByok && userByok.length > 0 && provider.type === 'vercel') {
    requestBodyParsed.model = await mapModelIdToVercel(requestBodyParsed.model);
  }

  const effectivePrivacy = getEffectiveProviderPrivacy(
    requestPrivacy.data,
    organizationDataCollection
  );
  const upstreamBody = buildUpstreamBody(
    {
      ...requestBodyParsed,
      ...(Object.keys(effectivePrivacy).length > 0 && {
        provider: { ...requestBodyParsed.provider, ...effectivePrivacy },
      }),
    },
    requestedModelLowerCased
  );

  if (userByok && userByok.length > 0 && provider.type === 'vercel') {
    const byokProviders: Record<string, unknown[]> = {};
    for (const byokEntry of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(byokEntry);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }
    upstreamBody.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
        zeroDataRetention: effectivePrivacy.zdr,
        disallowPromptTraining: effectivePrivacy.data_collection === 'deny' || undefined,
      },
    };
  }

  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;

  const response = await embeddingProxyRequest({
    body: upstreamBody,
    provider: effectiveProvider,
    signal: request.signal,
  });

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.ttfb_ms = ttfbMs;

  const metricsParams = {
    kiloUserId: user.id,
    organizationId,
    isAnonymous: isAnonymousContext(user),
    isStreaming: false,
    userByok: !!userByok,
    provider: provider.type,
    requestedModel: requestedModelLowerCased,
    resolvedModel: normalizeModelId(requestedModelLowerCased),
    toolsAvailable: [],
    toolsUsed: [],
    ttfbMs,
    statusCode: response.status,
  };

  usageContext.status_code = response.status;

  const upstreamErrorResponse = await applyUpstreamErrorPolicy({
    response,
    providerId: provider.type,
    isUserByok: !!userByok,
    user,
    request: upstreamBody,
    organizationId,
    model: requestedModelLowerCased,
  });
  if (upstreamErrorResponse) {
    emitGatewayApiMetrics({ ...metricsParams, completeRequestMs: ttfbMs });
    return upstreamErrorResponse;
  }

  const clonedResponse = response.clone();
  const accounting = countAndStoreEmbeddingUsage(
    clonedResponse,
    usageContext,
    embeddingRequestSpan,
    effectiveProvider
  );
  emitApiMetricsForResponse(metricsParams, accounting.statsPromise, requestStartedAt);

  return wrapInSafeNextResponse(response);
}
