import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { getTranscriptionProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { debugSaveLog, debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import {
  countAndStoreTranscriptionUsage,
  invalidRequestResponse,
  modelDoesNotExistResponse,
  extractHeaderAndLimitLength,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { providerPreferencesSchema } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  emitApiMetricsForResponse,
  emitGatewayApiMetrics,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import {
  responseUsageContext,
  rewriteModelResponse_UsageEndpoint,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.usageEndpoints';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  buildUpstreamBody,
  extractTranscriptionPromptInfo,
  TranscriptionRequestSchema,
  type TranscriptionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/transcriptions/transcription-request';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  fetchUpstream,
  UPSTREAM_DURATION_BUDGET_MS,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  freeModelRateLimitRejection,
  gatewayAccountRateLimitRejection,
  gatewayUsageContextBase,
  organizationGatewayPolicy,
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
import { signedInBouncerRequest } from '@kilocode/web-shared/lib/bouncer/request';

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
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    // A malformed body or a missing boundary rejects instead of returning form
    // data. This is client input, so answer the controlled 400 without
    // reporting it to Sentry. Never log the body: it is audio.
    errorExceptInTest('[transcription-proxy] Invalid multipart body:', error);
    return null;
  }
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
    errorExceptInTest('[transcription-proxy] Invalid JSON body:', error);
    return null;
  }

  const result = TranscriptionRequestSchema.safeParse(parsed);
  if (!result.success) {
    errorExceptInTest('[transcription-proxy] Invalid request body:', result.error.issues);
    return null;
  }

  return { kind: 'json', body: result.data };
}

export async function handleAudioTranscriptionsRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();

  const ipAddress = rawClientIp(request);
  // Like chat, cap the account before reading the body or authenticating.
  const accountRateLimited = await gatewayAccountRateLimitRejection(request, ipAddress);
  if (accountRateLimited) return accountRateLimited;

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
    { allowAnonymous: false, passThroughAuthFailure: true }
  );
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  const { user, organizationId } = caller;

  // Custom LLMs are served only through chat routes; never forward their ids
  // elsewhere. Checked after auth so anonymous callers cannot probe for them.
  if (await isCustomLlm(requestedModelLowerCased)) {
    return modelDoesNotExistResponse();
  }

  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER) || '');
  const isFree = isFreeModel(requestedModelLowerCased);
  if (isFree) {
    const rateLimited = await freeModelRateLimitRejection({
      request,
      caller,
      model: requestedModelLowerCased,
      feature,
    });
    if (rateLimited) return rateLimited;
  }

  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt });
  const { provider, userByok } = await getTranscriptionProvider();

  const bouncer = signedInBouncerRequest({
    ip: bareIpLiteral(ipAddress),
    ja4Digest: usageBase.context.fraudHeaders.http_x_vercel_ja4_digest,
    userId: user.id,
    organizationId,
    feature,
  });

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
    ...usageBase.context,
    api_kind: 'audio_transcriptions',
    provider: provider.type,
    requested_model: requestedModelLowerCased,
    is_free: isFree,
    promptInfo,
    isStreaming: false,
    user_byok: !!userByok,
    has_tools: false,
    feature,
  };
  const bouncerUsageFields = {
    occurredAt: new Date(requestStartedAtMs),
    clientAttributed: usageBase.clientAttributed,
    requestedLogprobs: false,
    samples: null,
    // Audio carries no user text, so there is no prompt to hash.
    promptSimHash: null,
  };

  setTag('ui.ai_model', requestedModel);

  const account = await readGatewayBalance(user, organizationId, requestedModelLowerCased);
  const { balance, settings, plan, payer } = account;

  // The usage row reports the payer the balance check resolved: the root organization for an
  // organization member.
  usageContext.bouncer = await bouncer.usage(bouncerUsageFields, payer);

  // Transcriptions only route to OpenRouter, which no data region pins, so only a
  // disabled gateway applies here.
  const gatewayPolicy = await organizationGatewayPolicy({ organizationId, settings, provider });
  if (gatewayPolicy.kind === 'rejected') return gatewayPolicy.response;

  // Free models are Kilo- or partner-funded: a zero balance never blocks them
  // (the embeddings proxy applies the same exemption).
  const creditsBlocked = paidUsageRejection({
    user,
    organizationId,
    account,
    exempt: usageContext.is_free || !!userByok,
  });
  if (creditsBlocked) return await creditsBlocked();

  // OpenRouter's transcription endpoint accepts the same provider preferences
  // as chat, so the organization data-collection policy and provider routes are
  // forwarded with the request instead of rejecting it.
  const requestProvider = parsedRequest.kind === 'json' ? parsedRequest.body.provider : undefined;
  const requestPrivacy = providerPreferencesSchema.optional().safeParse(requestProvider);
  if (!requestPrivacy.success) return invalidRequestResponse();
  const organizationDecision = organizationId
    ? (
        await resolveOrganizationMemberModelDecision({
          organizationId,
          kiloUserId: user.id,
          modelId: requestedModelLowerCased,
          fromDb: readDb,
        })
      ).decision
    : undefined;
  const preferences = organizationProviderPreferences({
    decision: organizationDecision,
    settings,
    requestProvider: requestPrivacy.data,
  });
  if (preferences.kind === 'rejected') return preferences.response;
  const organizationProvider = preferences.provider;

  // The one decide for this request, awaited just before the upstream call within its 500 ms
  // budget. Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise = bouncer.decide({
    tier: bouncerDecideTier(organizationId, plan, balance),
    payer,
  });

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
    // The multipart form takes the provider preferences as a JSON string.
    if (organizationProvider) {
      upstreamForm.append('provider', JSON.stringify(organizationProvider));
    }
    upstreamBody = upstreamForm;
  } else {
    parsedRequest.body.safety_identifier = generateProviderSpecificHash(user.id, provider);
    parsedRequest.body.user = parsedRequest.body.safety_identifier;
    if (organizationProvider) {
      parsedRequest.body.provider = { ...requestProvider, ...organizationProvider };
    }
    upstreamBody = buildUpstreamBody(parsedRequest.body);
  }

  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;

  const vercelRequestId = extractHeaderAndLimitLength(request, 'x-vercel-id');
  // The route's maxDuration matches chat's, and so does the usage work after the response.
  const upstream = await fetchUpstream({
    provider,
    path: '/audio/transcriptions',
    method: 'POST',
    body: upstreamBody,
    signal: request.signal,
    vercelRequestId,
    durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

  const metricsParams = {
    kiloUserId: user.id,
    organizationId,
    isAnonymous: false,
    isStreaming: false,
    userByok: !!userByok,
    provider: provider.type,
    requestedModel: requestedModelLowerCased,
    resolvedModel: normalizeModelId(requestedModelLowerCased),
    toolsAvailable: [],
    toolsUsed: [],
    ttfbMs,
    statusCode: upstream.response.status,
  };

  if (upstream.type === 'error') {
    emitGatewayApiMetrics({ ...metricsParams, completeRequestMs: ttfbMs });
    return upstream.response;
  }
  const { response } = upstream;
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

  const accounting = countAndStoreTranscriptionUsage(
    response.clone(),
    usageContext,
    span,
    provider
  );
  emitApiMetricsForResponse(metricsParams, accounting.statsPromise, requestStartedAt);
  return await rewriteModelResponse_UsageEndpoint({
    response,
    usageContext: responseUsageContext(usageContext, await getCustomPricingConfig()),
    vercelRequestId,
  });
}
