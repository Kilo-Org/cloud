import { randomUUID } from 'crypto';
import { MISTRAL_API_KEY, INCEPTION_API_KEY } from '@/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import z from 'zod';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import type { MicrodollarUsageContext } from '@/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { sentryRootSpan } from '@/lib/getRootSpan';
import { getUserFromAuth } from '@/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  countAndStoreFimUsage,
  extractFimPromptInfo,
  extractFraudAndProjectHeaders,
  invalidRequestResponse,
  temporarilyUnavailableResponse,
  wrapInSafeNextResponse,
  captureProxyError,
  extractHeaderAndLimitLength,
  modelNotAllowedResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { sentryLogger } from '@/lib/utils.server';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';
import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';
import { findSupportedFimModel, type FimProvider } from '@/lib/ai-gateway/supported-fim-models';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { bouncerAccountId, normalizeJa4 } from '@/lib/bouncer/client';
import {
  bareIpLiteral,
  bouncerDecideTier,
  payerSharingIp,
  rawClientIp,
  scheduleBouncerDecide,
} from '@/lib/bouncer/inference';

// Mistral exposes FIM on two separate, key-incompatible endpoints:
//   - https://api.mistral.ai          (La Plateforme, paid tier keys)
//   - https://codestral.mistral.ai    (Codestral free tier, "Codestral" keys from
//                                      https://console.mistral.ai/codestral)
// A Codestral key is rejected by api.mistral.ai, so BYOK keys stored as `codestral`
// must be routed to codestral.mistral.ai instead.
const MISTRAL_LA_PLATEFORME_FIM_URL = 'https://api.mistral.ai/v1/fim/completions';
const MISTRAL_CODESTRAL_FIM_URL = 'https://codestral.mistral.ai/v1/fim/completions';
const INCEPTION_FIM_URL = 'https://api.inceptionlabs.ai/v1/fim/completions';
const FIM_MAX_TOKENS_LIMIT = 1000;

function resolveFimProvider(model: string): {
  provider: FimProvider;
  upstreamModel: string;
} | null {
  const supportedModel = findSupportedFimModel(model);
  if (!supportedModel) return null;
  return {
    provider: supportedModel.provider,
    upstreamModel: supportedModel.upstreamModel,
  };
}

function resolveFimUpstreamUrl(provider: FimProvider, usingCodestralByok: boolean): string {
  if (provider === 'inception') return INCEPTION_FIM_URL;
  return usingCodestralByok ? MISTRAL_CODESTRAL_FIM_URL : MISTRAL_LA_PLATEFORME_FIM_URL;
}

function getSystemApiKey(provider: FimProvider): string | null {
  switch (provider) {
    case 'mistral':
      return MISTRAL_API_KEY || null;
    case 'inception':
      return INCEPTION_API_KEY || null;
  }
}

const FIMRequestBody = z.object({
  //ref: https://docs.mistral.ai/api/endpoint/fim#operation-fim_completion_v1_fim_completions_post
  model: z.string(),
  prompt: z.string(),
  suffix: z.string().optional(),
  max_tokens: z.number().optional(),
  min_tokens: z.number().optional(),
  stop: z.string().array().optional(),
  stream: z.boolean().optional(),
});

type FIMRequestBody = z.infer<typeof FIMRequestBody>;

export async function handleFimCompletionsRequest(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();
  const requesBodyTextPromise = request.text();

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId,
  } = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  });
  authSpan.end();
  if (authFailedResponse) return authFailedResponse;

  const user = maybeUser;
  const requestBodyText = await requesBodyTextPromise;
  debugSaveProxyRequest(requestBodyText);

  // Parse request body
  let requestBody: FIMRequestBody;
  try {
    const { success, data, error } = FIMRequestBody.safeParse(JSON.parse(requestBodyText));

    if (!success) {
      sentryLogger('fim-proxy')('request failed to parse', {
        extra: { kiloUserId: user.id, error, organizationId },
        tags: { source: 'fim-proxy' },
        user: { id: user.id },
      });
      return invalidRequestResponse();
    }
    requestBody = data;
  } catch (e) {
    captureException(e, {
      extra: { kiloUserId: user.id },
      tags: { source: 'fim-proxy' },
      user: { id: user.id },
    });
    return invalidRequestResponse();
  }

  // Resolve provider from model name
  const resolved = resolveFimProvider(requestBody.model);
  if (!resolved) {
    return NextResponse.json(
      {
        error: requestBody.model + ' is not a supported FIM model',
        error_type: ProxyErrorType.unsupported_fim_model,
      },
      { status: 400 }
    );
  }
  const { provider: fimProvider, upstreamModel } = resolved;

  // Validate max_tokens
  if (!requestBody.max_tokens || requestBody.max_tokens > FIM_MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: FIM Max tokens limit exceeded or missing: ${user.id}`, {
      maxTokens: requestBody.max_tokens,
    });
    return temporarilyUnavailableResponse();
  }

  // Use new shared helper for fraud & project headers
  const { fraudHeaders, projectId, xKiloCodeVersion } = extractFraudAndProjectHeaders(request);
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));

  // Resolve bouncer's identity once for this request. FIM is always signed in, so
  // its usage row uses a payer-safe IP that drops shared Kilo infrastructure.
  const bouncerIp = bareIpLiteral(rawClientIp(request));
  const bouncerRequestId = randomUUID();

  // Extract properties for usage context
  const promptInfo = extractFimPromptInfo(requestBody);

  const byokProviderKeys: UserByokProviderId[] =
    fimProvider === 'mistral' ? ['codestral', 'mistral'] : ['inception'];

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, byokProviderKeys)
    : await getBYOKforUser(readDb, user.id, byokProviderKeys);

  const usageContext: MicrodollarUsageContext = {
    api_kind: 'fim_completions',
    kiloUserId: user.id,
    provider: fimProvider,
    requested_model: requestBody.model,
    promptInfo,
    max_tokens: requestBody.max_tokens ?? null,
    has_middle_out_transform: null, // N/A for FIM
    fraudHeaders,
    isStreaming: requestBody.stream === true,
    organizationId,
    prior_microdollar_usage: user.microdollars_used,
    posthog_distinct_id: user.google_user_email,
    project_id: projectId,
    status_code: null,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    user_byok: !!userByok,
    has_tools: false,
    feature,
    session_id: taskId ?? null,
    mode: null,
    auto_model: null,
    ttfb_ms: null,
    bouncer: {
      requestId: bouncerRequestId,
      occurredAt: new Date(requestStartedAtMs),
      accountId: bouncerAccountId(user.id, organizationId),
      clientIp: payerSharingIp(bouncerIp, feature),
      clientAttributed: feature !== null || Boolean(xKiloCodeVersion),
      requestedLogprobs: false,
      samples: null,
      // FIM feeds volume rules only, which do not read a prompt hash.
      promptSimHash: null,
    },
  };

  setTag('ui.ai_model', requestBody.model);
  // Use read replica for balance check - this is a read-only operation that can tolerate
  // slight replication lag, and provides lower latency for US users
  const { balance, plan } = await getBalanceAndOrgSettings(organizationId, user, readDb);

  if (balance <= 0 && !isFreeModel(requestBody.model) && !userByok) {
    return NextResponse.json(
      {
        error: { message: 'Insufficient credits' },
        error_type: ProxyErrorType.insufficient_credits,
      },
      { status: 402 }
    );
  }

  if (organizationId) {
    const { decision } = await resolveOrganizationMemberModelDecision({
      organizationId,
      kiloUserId: user.id,
      modelId: requestBody.model,
    });
    if (!decision.allowed) return modelNotAllowedResponse();
    if (decision.eligibleProviderRoutes && !decision.eligibleProviderRoutes.has(fimProvider)) {
      return modelNotAllowedResponse();
    }
  }

  const systemKey = getSystemApiKey(fimProvider);
  const userByokEntry = byokProviderKeys
    .map(providerId => userByok?.find(entry => entry.providerId === providerId))
    .find(entry => entry !== undefined);
  const apiKey = userByokEntry?.decryptedAPIKey ?? systemKey;
  const upstreamUrl = resolveFimUpstreamUrl(fimProvider, userByokEntry?.providerId === 'codestral');

  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'This model requires a BYOK API key. Please configure your API key in settings.',
        error_type: ProxyErrorType.byok_key_required,
      },
      { status: 400 }
    );
  }

  // Report-only verdict: registered with after() and never awaited, so it cannot
  // hold up the upstream call and survives an early return.
  scheduleBouncerDecide({
    requestId: bouncerRequestId,
    ip: bouncerIp,
    ja4: normalizeJa4(fraudHeaders.http_x_vercel_ja4_digest),
    account: {
      accountId: bouncerAccountId(user.id, organizationId),
      tier: bouncerDecideTier(organizationId, plan, balance),
    },
  });

  sentryRootSpan()?.setAttribute(
    'fim.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const fimRequestSpan = startInactiveSpan({
    name: 'fim-request-start',
    op: 'http.client',
  });

  const bodyForUpstream = { ...requestBody, model: upstreamModel };

  // Make upstream request to the resolved provider
  const proxyRes = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(bodyForUpstream),
  });
  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.ttfb_ms = ttfbMs;
  usageContext.status_code = proxyRes.status;

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: false,
      isStreaming: requestBody.stream === true,
      userByok: !!userByokEntry,
      provider: fimProvider,
      requestedModel: requestBody.model,
      resolvedModel: requestBody.model,
      toolsAvailable: [],
      toolsUsed: [],
      ttfbMs,
      statusCode: proxyRes.status,
    },
    proxyRes.clone(),
    requestStartedAt
  );

  if (!proxyRes.body) {
    return NextResponse.json(
      {
        error: 'No body returned from upstream',
        error_type: ProxyErrorType.upstream_error,
      },
      { status: 500 }
    );
  }

  // Handle errors
  if (proxyRes.status >= 400) {
    await captureProxyError({
      user,
      request: bodyForUpstream,
      response: proxyRes,
      organizationId,
      model: requestBody.model,
      errorMessage: `FIM provider returned error ${proxyRes.status}`,
      trackInSentry: proxyRes.status >= 500,
    });
  }

  const clonedResponse = proxyRes.clone(); // reading from body is side-effectful

  // Account for usage using FIM-specific parser
  countAndStoreFimUsage(clonedResponse, usageContext, fimRequestSpan);

  return wrapInSafeNextResponse(proxyRes);
}
