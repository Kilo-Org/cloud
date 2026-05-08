import { MISTRAL_API_KEY, INCEPTION_API_KEY } from '@/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import z from 'zod';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import type { MicrodollarUsageContext } from '@/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { isFreeModel } from '@/lib/ai-gateway/models';
import { sentryRootSpan } from '@/lib/getRootSpan';
import { getUserFromAuth } from '@/lib/user.server';
import {
  checkOrganizationModelRestrictions,
  countAndStoreFimUsage,
  extractFimPromptInfo,
  extractFraudAndProjectHeaders,
  invalidRequestResponse,
  temporarilyUnavailableResponse,
  wrapInSafeNextResponse,
  captureProxyError,
  extractHeaderAndLimitLength,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { sentryLogger } from '@/lib/utils.server';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';

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

type FimProvider = 'mistral' | 'inception';

function resolveFimProvider(model: string): {
  provider: FimProvider;
  upstreamModel: string;
} | null {
  if (model.startsWith('mistralai/')) {
    return {
      provider: 'mistral',
      upstreamModel: model.slice('mistralai/'.length),
    };
  }
  if (model.startsWith('inception/')) {
    return {
      provider: 'inception',
      upstreamModel: model.slice('inception/'.length),
    };
  }
  return null;
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

export async function POST(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requesBodyTextPromise = request.text();

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId,
  } = await getUserFromAuth({ adminOnly: false });
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
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;

  // Extract properties for usage context
  const promptInfo = extractFimPromptInfo(requestBody);

  const byokProviderKey = fimProvider === 'mistral' ? 'codestral' : 'inception';

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, [byokProviderKey])
    : await getBYOKforUser(readDb, user.id, [byokProviderKey]);

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
    feature: validateFeatureHeader(request.headers.get(FEATURE_HEADER)),
    session_id: taskId ?? null,
    mode: null,
    auto_model: null,
    ttfb_ms: null,
  };

  setTag('ui.ai_model', requestBody.model);
  // Use read replica for balance check - this is a read-only operation that can tolerate
  // slight replication lag, and provides lower latency for US users
  const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user, readDb);

  if (balance <= 0 && !isFreeModel(requestBody.model) && !userByok) {
    return NextResponse.json(
      {
        error: { message: 'Insufficient credits' },
        error_type: ProxyErrorType.insufficient_credits,
      },
      { status: 402 }
    );
  }

  // Use shared helper for organization model restrictions.
  const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
    modelId: requestBody.model,
    settings,
    organizationPlan: plan,
  });
  if (modelRestrictionError) return modelRestrictionError;

  // FIM routes directly to providers, so enforce the resolved provider name here.
  if (providerConfig?.only && !providerConfig.only.includes(fimProvider)) {
    return NextResponse.json(
      {
        error: 'Provider not allowed for your team.',
        error_type: ProxyErrorType.provider_not_allowed,
        message: `The provider "${fimProvider}" is not allowed for your team.`,
      },
      { status: 403 }
    );
  }

  if (providerConfig?.ignore?.includes(fimProvider)) {
    return NextResponse.json(
      {
        error: 'Provider not allowed for your team.',
        error_type: ProxyErrorType.provider_not_allowed,
        message: `The provider "${fimProvider}" is not allowed for your team.`,
      },
      { status: 403 }
    );
  }

  const systemKey = getSystemApiKey(fimProvider);
  const userByokEntry = userByok?.at(0);
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
  usageContext.ttfb_ms = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.status_code = proxyRes.status;

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
