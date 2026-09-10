import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { generateProviderSpecificHash } from '@/lib/ai-gateway/providerHash';
import type { MicrodollarUsageContext } from '@/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { getTranscriptionProvider } from '@/lib/ai-gateway/providers/get-provider';
import { debugSaveLog, debugSaveProxyRequest } from '@/lib/debugUtils';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@/lib/getRootSpan';
import {
  captureProxyError,
  checkOrganizationModelRestrictions,
  countAndStoreTranscriptionUsage,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  invalidRequestResponse,
  modelNotAllowedResponse,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import type { OpenRouterProviderConfig } from '@/lib/ai-gateway/providers/openrouter/types';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  buildUpstreamBody,
  extractTranscriptionPromptInfo,
  TranscriptionRequestSchema,
  type TranscriptionRequest,
} from '@/lib/ai-gateway/transcriptions/transcription-request';
import type { PromptInfo } from '@/lib/ai-gateway/processUsage.types';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';

export const maxDuration = 800;

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';

async function transcriptionProxyRequest(params: {
  body: Record<string, unknown> | FormData;
  provider: Provider;
  signal?: AbortSignal;
}) {
  const { body, provider, signal } = params;
  // No explicit Content-Type for a multipart body: fetch sets the boundary.
  const isMultipartBody = body instanceof FormData;
  const headers = new Headers();
  if (!isMultipartBody) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${provider.apiKey}`);

  for (const [key, value] of Object.entries(ATTRIBUTION_HEADERS)) {
    headers.set(key, value);
  }

  const timeout = AbortSignal.timeout(10 * 60 * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  return await fetch(`${provider.apiUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: isMultipartBody ? body : JSON.stringify(body),
    // @ts-expect-error see https://github.com/node-fetch/node-fetch/issues/1769
    duplex: 'half',
    signal: combined,
  });
}

/** Prompt info attributed from a multipart upload: file name and size. */
function extractMultipartPromptInfo(file: File, language: string | null): PromptInfo {
  const languagePart = language ? ` language=${language.slice(0, 32)}` : '';
  return {
    system_prompt_prefix: '',
    system_prompt_length: 0,
    user_prompt_prefix: `audio/${file.name} size=${file.size}${languagePart}`.slice(0, 100),
  };
}

function extractMultipartLanguage(formData: FormData): string | null {
  const language = formData.get('language');
  return typeof language === 'string' && language.trim().length > 0 ? language.trim() : null;
}

/**
 * Either a JSON transcription body or a multipart upload. The request body
 * stream is single-consumption, so the shape is resolved once, from the
 * content-type header, before anything reads the body.
 */
type ParsedTranscriptionRequest =
  | { kind: 'json'; body: TranscriptionRequest }
  | { kind: 'multipart'; file: File; model: string; language: string | null };

async function parseMultipartTranscriptionRequest(
  request: NextRequest
): Promise<ParsedTranscriptionRequest | null> {
  const formData = await request.formData();
  const modelField = formData.get('model');
  if (typeof modelField !== 'string' || modelField.trim().length === 0) return null;
  const filePart = formData.get('file');
  if (!filePart || typeof filePart === 'string') return null;
  return {
    kind: 'multipart',
    file: filePart,
    model: modelField.trim(),
    language: extractMultipartLanguage(formData),
  };
}

function parseJsonTranscriptionRequest(requestBodyText: string): ParsedTranscriptionRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBodyText);
  } catch (error) {
    captureException(error, {
      extra: { requestBodyText },
      tags: { source: 'transcription-proxy' },
    });
    return null;
  }

  const result = TranscriptionRequestSchema.safeParse(parsed);
  if (!result.success) {
    captureException(result.error, {
      extra: { requestBodyText },
      tags: { source: 'transcription-proxy' },
    });
    return null;
  }

  return { kind: 'json', body: result.data };
}

export async function POST(request: NextRequest): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();

  const isMultipartRequest = (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('multipart/form-data');

  let requestBodyText: string | undefined;
  let parsedRequest: ParsedTranscriptionRequest | null;
  if (isMultipartRequest) {
    parsedRequest = await parseMultipartTranscriptionRequest(request);
  } else {
    requestBodyText = await request.text();
    debugSaveProxyRequest(requestBodyText);
    parsedRequest = parseJsonTranscriptionRequest(requestBodyText);
  }
  if (!parsedRequest) return invalidRequestResponse();

  const requestedModel =
    parsedRequest.kind === 'json' ? parsedRequest.body.model.trim() : parsedRequest.model;
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
  } = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  });
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
  const promptInfo =
    parsedRequest.kind === 'multipart'
      ? extractMultipartPromptInfo(parsedRequest.file, parsedRequest.language)
      : extractTranscriptionPromptInfo(parsedRequest.body);

  if (parsedRequest.kind === 'multipart') {
    debugSaveLog(
      `multipart file="${parsedRequest.file.name}" bytes=${parsedRequest.file.size} model="${parsedRequest.model}"`,
      'log.req.txt'
    );
  }

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

  setTag('ui.ai_model', requestedModel);

  const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user);

  // Free models are Kilo- or partner-funded: a zero balance never blocks them
  // (the embeddings proxy applies the same exemption).
  if (balance <= 0 && !(await isFreeModel(requestedModelLowerCased)) && !userByok) {
    return await usageLimitExceededResponse(user, balance);
  }

  const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
    modelId: requestedModelLowerCased,
    settings,
    organizationPlan: plan,
  });
  if (modelRestrictionError) return modelRestrictionError;

  // The resolved org policy follows the request shape: merged into the JSON
  // body, or appended to the multipart form (OpenRouter accepts the provider
  // field on both).
  let providerPolicy: OpenRouterProviderConfig | undefined;
  if (organizationId) {
    const { decision } = await resolveOrganizationMemberModelDecision({
      organizationId,
      kiloUserId: user.id,
      modelId: requestedModelLowerCased,
    });
    if (!decision.allowed) return modelNotAllowedResponse();
    if (decision.eligibleProviderRoutes) {
      const currentOnly = providerConfig?.only;
      const only = currentOnly
        ? currentOnly.filter(route => decision.eligibleProviderRoutes?.has(route))
        : [...decision.eligibleProviderRoutes];
      if (only.length === 0) return modelNotAllowedResponse();
      providerPolicy = { ...providerConfig, only };
    } else if (providerConfig) {
      providerPolicy = providerConfig;
    }
  } else if (providerConfig) {
    providerPolicy = providerConfig;
  }

  sentryRootSpan()?.setAttribute(
    'transcription.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const span = startInactiveSpan({ name: 'transcription-request-start', op: 'http.client' });

  let upstreamBody: Record<string, unknown> | FormData;
  if (parsedRequest.kind === 'multipart') {
    const upstreamForm = new FormData();
    upstreamForm.append('file', parsedRequest.file, parsedRequest.file.name);
    upstreamForm.append('model', requestedModel);
    if (parsedRequest.language) upstreamForm.append('language', parsedRequest.language);
    const safetyIdentifier = generateProviderSpecificHash(user.id, provider);
    upstreamForm.append('safety_identifier', safetyIdentifier);
    upstreamForm.append('user', safetyIdentifier);
    if (providerPolicy) {
      upstreamForm.append('provider', JSON.stringify(providerPolicy));
    }
    upstreamBody = upstreamForm;
  } else {
    parsedRequest.body.safety_identifier = generateProviderSpecificHash(user.id, provider);
    parsedRequest.body.user = parsedRequest.body.safety_identifier;
    if (providerPolicy) {
      parsedRequest.body.provider = { ...parsedRequest.body.provider, ...providerPolicy };
    }
    upstreamBody = buildUpstreamBody(parsedRequest.body);
  }

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
