import { MISTRAL_API_KEY, INCEPTION_API_KEY } from '@kilocode/web-shared/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import z from 'zod';
import { setTag, startInactiveSpan } from '@sentry/nextjs';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  countAndStoreFimUsage,
  extractFimPromptInfo,
  invalidRequestResponse,
  malformedJsonResponse,
  temporarilyUnavailableResponse,
  wrapInSafeNextResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { getBYOKforOrganization, getBYOKforUser } from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { checkDirectProviderAccess } from '@kilocode/web-shared/lib/ai-gateway/direct-provider-access';
import {
  gatewayUsageContextBase,
  resolveGatewayCaller,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  findSupportedFimModel,
  type FimProvider,
} from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';
import {
  emitApiMetricsForResponse,
  emitGatewayApiMetrics,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  bareIpLiteral,
  bouncerDecideTier,
  rawClientIp,
} from '@kilocode/web-shared/lib/bouncer/inference';
import { signedInBouncerRequest } from '@kilocode/web-shared/lib/bouncer/request';

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

export async function handleFimCompletionsRequest(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();
  const requesBodyTextPromise = request.text();

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const caller = resolveGatewayCaller(
    await getUserFromAuth({ adminOnly: false, expectedAudience: KILO_GATEWAY_AUDIENCE }),
    { allowAnonymous: false, passThroughAuthFailure: true }
  );
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  const { user, organizationId } = caller;
  const requestBodyText = await requesBodyTextPromise;
  debugSaveProxyRequest(requestBodyText);

  let requestJson: unknown;
  try {
    requestJson = JSON.parse(requestBodyText);
  } catch (e) {
    return malformedJsonResponse(e);
  }
  const { success, data: requestBody, error } = FIMRequestBody.safeParse(requestJson);
  if (!success) {
    sentryLogger('fim-proxy')('request failed to parse', {
      extra: { kiloUserId: user.id, error, organizationId },
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

  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt });
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));

  const bouncer = signedInBouncerRequest({
    ip: bareIpLiteral(rawClientIp(request)),
    ja4Digest: usageBase.context.fraudHeaders.http_x_vercel_ja4_digest,
    userId: user.id,
    organizationId,
    feature,
  });

  // Extract properties for usage context
  const promptInfo = extractFimPromptInfo(requestBody);

  const byokProviderKeys: UserByokProviderId[] =
    fimProvider === 'mistral' ? ['codestral', 'mistral'] : ['inception'];

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, byokProviderKeys)
    : await getBYOKforUser(readDb, user.id, byokProviderKeys);
  const userByokEntry = byokProviderKeys
    .map(providerId => userByok?.find(entry => entry.providerId === providerId))
    .find(entry => entry !== undefined);

  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    api_kind: 'fim_completions',
    provider: fimProvider,
    requested_model: requestBody.model,
    is_free: isFreeModel(requestBody.model),
    promptInfo,
    max_tokens: requestBody.max_tokens ?? null,
    isStreaming: requestBody.stream === true,
    user_byok: !!userByokEntry,
    has_tools: false,
    feature,
    bouncer: bouncer.usage({
      occurredAt: new Date(requestStartedAtMs),
      clientAttributed: usageBase.clientAttributed,
      requestedLogprobs: false,
      samples: null,
      // FIM feeds volume rules only, which do not read a prompt hash.
      promptSimHash: null,
    }),
  };

  setTag('ui.ai_model', requestBody.model);
  const accessResult = await checkDirectProviderAccess({
    user,
    organizationId,
    model: requestBody.model,
    provider: fimProvider,
    isFreeUsage: usageContext.is_free,
    hasByok: !!userByokEntry,
  });
  if (accessResult.rejection) return accessResult.rejection;
  const { balance, plan, payer } = accessResult.access;

  // Data-use contract for this route: FIM goes straight to the provider, and the supported
  // providers are classified by the gateway's provider data policy as not training on prompts
  // (https://openrouter.ai/docs/guides/privacy/provider-logging). A new supported model must
  // carry the same classification.

  const systemKey = getSystemApiKey(fimProvider);
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

  // The one decide for this request, awaited before the upstream call within its 500 ms budget.
  // Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise = bouncer.decide({
    tier: bouncerDecideTier(organizationId, plan, balance),
    payer,
  });
  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;

  sentryRootSpan()?.setAttribute(
    'fim.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const fimRequestSpan = startInactiveSpan({
    name: 'fim-request-start',
    op: 'http.client',
  });

  const bodyForUpstream = {
    ...requestBody,
    model: upstreamModel,
    // Inception reports usage in a stream only when asked. Mistral always does and accepts it.
    ...(requestBody.stream ? { stream_options: { include_usage: true } } : {}),
  };

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
  usageContext.status_code = proxyRes.status;

  const metricsParams = {
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
  };

  if (!proxyRes.body) {
    emitGatewayApiMetrics({ ...metricsParams, completeRequestMs: ttfbMs });
    return NextResponse.json(
      {
        error: 'No body returned from upstream',
        error_type: ProxyErrorType.upstream_error,
      },
      { status: 500 }
    );
  }

  const upstreamErrorResponse = await applyUpstreamErrorPolicy({
    response: proxyRes,
    providerId: fimProvider,
    isUserByok: !!userByokEntry,
    user,
    request: bodyForUpstream,
    organizationId,
    model: requestBody.model,
  });

  const clonedResponse = proxyRes.clone(); // reading from body is side-effectful

  const accounting = countAndStoreFimUsage(clonedResponse, usageContext, fimRequestSpan);
  emitApiMetricsForResponse(metricsParams, accounting.statsPromise, requestStartedAt);

  return upstreamErrorResponse ?? wrapInSafeNextResponse(proxyRes);
}
