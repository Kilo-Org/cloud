import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { generateProviderSpecificHash } from '@/lib/providerHash';
import type { MicrodollarUsageContext } from '@/lib/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { getEmbeddingProvider } from '@/lib/providers';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user.server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import { isFreeModel } from '@/lib/models';
import {
  captureProxyError,
  checkOrganizationModelRestrictions,
  countAndStoreEmbeddingUsage,
  extractEmbeddingPromptInfo,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  invalidRequestResponse,
  modelDoesNotExistResponse,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
} from '@/lib/llm-proxy-helpers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import {
  createAnonymousContext,
  isAnonymousContext,
  type AnonymousUserContext,
} from '@/lib/anonymous';
import { emitApiMetricsForResponse } from '@/lib/o11y/api-metrics.server';
import { normalizeModelId } from '@/lib/model-utils';
import { buildUpstreamBody, type EmbeddingProxyRequest } from '@/lib/embeddings/embedding-request';
import { mapModelIdToVercel } from '@/lib/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/providers/vercel';
import type { Provider } from '@/lib/providers/types';

export const maxDuration = 300;

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';

async function embeddingProxyRequest(params: {
  body: Record<string, unknown>;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const { body, provider, signal } = params;
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  // OpenRouter needs these identification headers (same as openRouterRequest)
  if (provider.id === 'openrouter' || provider.id === 'vercel') {
    headers.set('HTTP-Referer', 'https://kilocode.ai');
    headers.set('X-Title', 'Kilo Code');
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

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  // Parse body first to check model before auth (needed for anonymous access)
  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  let requestBodyParsed: EmbeddingProxyRequest;
  try {
    requestBodyParsed = JSON.parse(requestBodyText);
  } catch (e) {
    captureException(e, {
      extra: { requestBodyText },
      tags: { source: 'embedding-proxy' },
    });
    return invalidRequestResponse();
  }

  if (typeof requestBodyParsed.model !== 'string' || requestBodyParsed.model.trim().length === 0) {
    return modelDoesNotExistResponse();
  }

  if (requestBodyParsed.input == null) {
    return invalidRequestResponse();
  }

  const requestedModel = requestBodyParsed.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

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

  // Auth check
  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId: authOrganizationId,
    botId: authBotId,
    tokenSource: authTokenSource,
  } = await getUserFromAuth({ adminOnly: false });
  authSpan.end();

  let user: typeof maybeUser | AnonymousUserContext;
  let organizationId: string | undefined = authOrganizationId;
  const botId: string | undefined = authBotId;
  const tokenSource: string | undefined = authTokenSource;

  if (authFailedResponse) {
    if (!isFreeModel(requestedModelLowerCased)) {
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

    user = createAnonymousContext(ipAddress);
    organizationId = undefined;
  } else {
    user = maybeUser;
  }

  // Extract fraud/project headers
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);

  const { provider, userByok } = await getEmbeddingProvider(
    requestedModelLowerCased,
    user,
    organizationId
  );

  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || 'embeddings');

  // Build usage context
  const promptInfo = extractEmbeddingPromptInfo(requestBodyParsed);

  const usageContext: MicrodollarUsageContext = {
    api_kind: 'embeddings',
    kiloUserId: user.id,
    provider: provider.id,
    requested_model: requestedModelLowerCased,
    promptInfo,
    max_tokens: null,
    has_middle_out_transform: null,
    fraudHeaders,
    isStreaming: false,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    user_byok: !!userByok,
    has_tools: false,
    botId,
    tokenSource,
    feature,
    session_id: null,
    mode: null,
    auto_model: null,
  };

  setTag('ui.ai_model', requestBodyParsed.model);

  // Skip balance/org checks for anonymous users — they can only use free models
  if (!isAnonymousContext(user)) {
    const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user);

    if (balance <= 0 && !isFreeModel(requestedModelLowerCased) && !userByok) {
      return await usageLimitExceededResponse(user, balance);
    }

    const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
      modelId: requestedModelLowerCased,
      settings,
      organizationPlan: plan,
    });
    if (modelRestrictionError) return modelRestrictionError;

    if (providerConfig) {
      requestBodyParsed.provider = providerConfig;
    }
  }

  sentryRootSpan()?.setAttribute(
    'embedding.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const embeddingRequestSpan = startInactiveSpan({
    name: 'embedding-request-start',
    op: 'http.client',
  });

  // Always set the hashed identifier for upstream abuse attribution / safety scoping
  requestBodyParsed.safety_identifier = generateProviderSpecificHash(user.id, provider);

  // BYOK: for Vercel gateway, pass the user's key via providerOptions (same as chat completions).
  const effectiveProvider = provider;

  if (userByok && userByok.length > 0 && provider.id === 'vercel') {
    requestBodyParsed.model = mapModelIdToVercel(requestBodyParsed.model);
  }

  const upstreamBody = buildUpstreamBody(requestBodyParsed);

  if (userByok && userByok.length > 0 && provider.id === 'vercel') {
    const byokProviders: Record<string, unknown[]> = {};
    for (const byokEntry of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(byokEntry);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }
    upstreamBody.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
      },
    };
  }

  const response = await embeddingProxyRequest({
    body: upstreamBody,
    provider: effectiveProvider,
    signal: request.signal,
  });

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: false,
      userByok: !!userByok,
      provider: provider.id,
      requestedModel: requestedModelLowerCased,
      resolvedModel: normalizeModelId(requestedModelLowerCased),
      toolsAvailable: [],
      toolsUsed: [],
      ttfbMs,
      statusCode: response.status,
    },
    response.clone(),
    requestStartedAt
  );

  usageContext.status_code = response.status;

  // Handle upstream 402 — don't pass through to client (same as chat completions)
  if (response.status === 402 && !userByok) {
    await captureProxyError({
      user,
      request: upstreamBody,
      response,
      organizationId,
      model: requestedModelLowerCased,
      errorMessage: `${provider.id} returned 402 Payment Required`,
      trackInSentry: true,
    });
    return temporarilyUnavailableResponse();
  }

  if (response.status >= 400) {
    await captureProxyError({
      user,
      request: upstreamBody,
      response,
      organizationId,
      model: requestedModelLowerCased,
      errorMessage: `${provider.id} returned error ${response.status}`,
      trackInSentry: response.status >= 500,
    });
  }

  const clonedResponse = response.clone();
  countAndStoreEmbeddingUsage(clonedResponse, usageContext, embeddingRequestSpan);

  return wrapInSafeNextResponse(response);
}
