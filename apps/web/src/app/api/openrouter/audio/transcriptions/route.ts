import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { generateProviderSpecificHash } from '@/lib/ai-gateway/providerHash';
import type { MicrodollarUsageContext } from '@/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { getTranscriptionProvider } from '@/lib/ai-gateway/providers/get-provider';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user/server';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  captureProxyError,
  checkOrganizationModelRestrictions,
  countAndStoreTranscriptionUsage,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  invalidRequestResponse,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  buildUpstreamBody,
  extractTranscriptionPromptInfo,
  TranscriptionRequestSchema,
} from '@/lib/ai-gateway/transcriptions/transcription-request';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const maxDuration = 300;

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';

async function transcriptionProxyRequest(params: {
  body: Record<string, unknown>;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const { body, provider, signal } = params;
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  for (const [key, value] of Object.entries(ATTRIBUTION_HEADERS)) {
    headers.set(key, value);
  }

  const timeout = AbortSignal.timeout(10 * 60 * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  return await fetch(`${provider.apiUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
    duplex: 'half',
    signal: combined,
  });
}

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBodyText);
  } catch (error) {
    captureException(error, {
      extra: { requestBodyText },
      tags: { source: 'transcription-proxy' },
    });
    return invalidRequestResponse();
  }

  const result = TranscriptionRequestSchema.safeParse(parsed);
  if (!result.success) {
    captureException(result.error, {
      extra: { requestBodyText },
      tags: { source: 'transcription-proxy' },
    });
    return invalidRequestResponse();
  }

  const body = result.data;
  const requestedModel = body.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

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

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId: authOrganizationId,
    botId: authBotId,
    tokenSource: authTokenSource,
  } = await getUserFromAuth({ adminOnly: false });
  authSpan.end();

  const organizationId: string | undefined = authOrganizationId;
  const botId: string | undefined = authBotId;
  const tokenSource: string | undefined = authTokenSource;

  if (authFailedResponse || !maybeUser) {
    return NextResponse.json(
      {
        error: {
          code: PAID_MODEL_AUTH_REQUIRED,
          message: 'You need to sign in to use speech-to-text.',
        },
        error_type: ProxyErrorType.paid_model_auth_required,
      },
      { status: 401 }
    );
  }

  const user = maybeUser;

  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const { provider, userByok } = await getTranscriptionProvider();
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || '');
  const promptInfo = extractTranscriptionPromptInfo(body);

  const usageContext: MicrodollarUsageContext = {
    api_kind: 'audio_transcriptions',
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
    posthog_distinct_id: user.google_user_email,
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
    ttfb_ms: null,
  };

  setTag('ui.ai_model', body.model);

  const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user);

  if (balance <= 0 && !userByok) {
    return await usageLimitExceededResponse(user, balance);
  }

  const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
    modelId: requestedModelLowerCased,
    settings,
    organizationPlan: plan,
  });
  if (modelRestrictionError) return modelRestrictionError;

  if (providerConfig) {
    body.provider = { ...body.provider, ...providerConfig };
  }

  sentryRootSpan()?.setAttribute(
    'transcription.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const span = startInactiveSpan({ name: 'transcription-request-start', op: 'http.client' });
  body.safety_identifier = generateProviderSpecificHash(user.id, provider);
  body.user = body.safety_identifier;
  const upstreamBody = buildUpstreamBody(body);

  const response = await transcriptionProxyRequest({
    body: upstreamBody,
    provider,
    signal: request.signal,
  });

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.ttfb_ms = ttfbMs;
  usageContext.status_code = response.status;

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: false,
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

  countAndStoreTranscriptionUsage(response.clone(), usageContext, span);
  return wrapInSafeNextResponse(response);
}
