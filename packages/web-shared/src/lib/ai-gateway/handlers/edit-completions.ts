import { INCEPTION_API_KEY } from '@kilocode/web-shared/lib/config.server';
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
  countAndStoreEditUsage,
  extractEditPromptInfo,
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
import { findSupportedFimModel } from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';
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

// Inception's edit endpoint mirrors a chat completion shape but is hosted at
// a separate path. It accepts a single `role: "user"` message; the system prompt
// is baked in server-side and the endpoint returns 400 for any `role: "system"`
// message. See https://docs.inceptionlabs.ai/api-reference/edit/create-a-code-edit-completion
const INCEPTION_EDIT_URL = 'https://api.inceptionlabs.ai/v1/edit/completions';
const EDIT_MAX_TOKENS_LIMIT = 1000;

type EditProvider = 'inception';

function resolveEditProvider(model: string): {
  provider: EditProvider;
  upstreamModel: string;
} | null {
  const supportedModel = findSupportedFimModel(model);
  if (supportedModel?.provider !== 'inception') return null;
  return {
    provider: supportedModel.provider,
    upstreamModel: supportedModel.upstreamModel,
  };
}

function getSystemApiKey(provider: EditProvider): string | null {
  switch (provider) {
    case 'inception':
      return INCEPTION_API_KEY || null;
  }
}

const EditMessage = z.object({
  role: z.literal('user'),
  content: z.string(),
});

const EditRequestBody = z.object({
  model: z.string(),
  messages: z.array(EditMessage).length(1),
  max_tokens: z.number().int().positive().optional(),
  stop: z.string().array().optional(),
  // Streaming is not supported by Inception's edit endpoint today; reject if requested.
  stream: z.literal(false).optional(),
});

export async function handleEditCompletionsRequest(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();
  const requestBodyTextPromise = request.text();

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const caller = resolveGatewayCaller(
    await getUserFromAuth({ adminOnly: false, expectedAudience: KILO_GATEWAY_AUDIENCE }),
    { allowAnonymous: false, passThroughAuthFailure: true }
  );
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  const { user, organizationId } = caller;
  const requestBodyText = await requestBodyTextPromise;
  debugSaveProxyRequest(requestBodyText);

  let requestJson: unknown;
  try {
    requestJson = JSON.parse(requestBodyText);
  } catch (e) {
    return malformedJsonResponse(e);
  }
  const { success, data: requestBody, error } = EditRequestBody.safeParse(requestJson);
  if (!success) {
    if (error.issues.some(issue => issue.path[0] === 'stream')) {
      return NextResponse.json(
        {
          error: 'Streaming is not supported for edit completions',
          error_type: ProxyErrorType.unsupported_field,
        },
        { status: 400 }
      );
    }
    sentryLogger('edit-proxy')('request failed to parse', {
      extra: { kiloUserId: user.id, error, organizationId },
      tags: { source: 'edit-proxy' },
      user: { id: user.id },
    });
    return invalidRequestResponse();
  }

  const resolved = resolveEditProvider(requestBody.model);
  if (!resolved) {
    return NextResponse.json(
      {
        error: requestBody.model + ' is not a supported edit model',
        error_type: ProxyErrorType.unsupported_edit_model,
      },
      { status: 400 }
    );
  }
  const { provider: editProvider, upstreamModel } = resolved;

  if (!requestBody.max_tokens || requestBody.max_tokens > EDIT_MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Edit max tokens limit exceeded or missing: ${user.id}`, {
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

  const promptInfo = extractEditPromptInfo(requestBody);

  const byokProviderKey: UserByokProviderId = 'inception';

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, [byokProviderKey])
    : await getBYOKforUser(readDb, user.id, [byokProviderKey]);
  const userByokEntry = userByok?.find(entry => entry.providerId === byokProviderKey);

  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    api_kind: 'edit_completions',
    provider: editProvider,
    requested_model: requestBody.model,
    is_free: isFreeModel(requestBody.model),
    promptInfo,
    max_tokens: requestBody.max_tokens ?? null,
    isStreaming: false,
    user_byok: !!userByokEntry,
    has_tools: false,
    feature,
    bouncer: bouncer.usage({
      occurredAt: new Date(requestStartedAtMs),
      clientAttributed: usageBase.clientAttributed,
      requestedLogprobs: false,
      samples: null,
      // Edit feeds volume rules only, which do not read a prompt hash.
      promptSimHash: null,
    }),
  };

  setTag('ui.ai_model', requestBody.model);
  const accessResult = await checkDirectProviderAccess({
    user,
    organizationId,
    model: requestBody.model,
    provider: editProvider,
    isFreeUsage: usageContext.is_free,
    hasByok: !!userByokEntry,
  });
  if (accessResult.rejection) return accessResult.rejection;
  const { balance, plan, payer } = accessResult.access;

  // Data-use contract for this route: edit goes straight to Inception, which the gateway's
  // provider data policy classifies as not training on prompts and not retaining them
  // (https://openrouter.ai/docs/guides/privacy/provider-logging). A new supported model must
  // carry the same classification.

  const systemKey = getSystemApiKey(editProvider);
  const apiKey = userByokEntry?.decryptedAPIKey ?? systemKey;

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
    'edit.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const requestSpan = startInactiveSpan({
    name: 'edit-request-start',
    op: 'http.client',
  });

  const bodyForUpstream = { ...requestBody, model: upstreamModel };

  const proxyRes = await fetch(INCEPTION_EDIT_URL, {
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
    isStreaming: false,
    userByok: !!userByokEntry,
    provider: editProvider,
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
    providerId: editProvider,
    isUserByok: !!userByokEntry,
    user,
    request: bodyForUpstream,
    organizationId,
    model: requestBody.model,
  });

  const clonedResponse = proxyRes.clone();

  const accounting = countAndStoreEditUsage(clonedResponse, usageContext, requestSpan);
  emitApiMetricsForResponse(metricsParams, accounting.statsPromise, requestStartedAt);

  return upstreamErrorResponse ?? wrapInSafeNextResponse(proxyRes);
}
