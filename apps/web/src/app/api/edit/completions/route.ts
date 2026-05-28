import { INCEPTION_API_KEY } from '@/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import z from 'zod';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import type { MicrodollarUsageContext } from '@/lib/ai-gateway/processUsage.types';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { sentryRootSpan } from '@/lib/getRootSpan';
import { getUserFromAuth } from '@/lib/user/server';
import {
  checkOrganizationModelRestrictions,
  countAndStoreEditUsage,
  extractEditPromptInfo,
  extractFraudAndProjectHeaders,
  invalidRequestResponse,
  dataCollectionRequiredResponse,
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
import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

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
  if (model.startsWith('inception/')) {
    return {
      provider: 'inception',
      upstreamModel: model.slice('inception/'.length),
    };
  }
  return null;
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

type EditRequestBody = z.infer<typeof EditRequestBody>;

export async function POST(request: NextRequest) {
  const requestStartedAt = performance.now();
  const requestBodyTextPromise = request.text();

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const {
    user: maybeUser,
    authFailedResponse,
    organizationId,
  } = await getUserFromAuth({ adminOnly: false });
  authSpan.end();
  if (authFailedResponse) return authFailedResponse;

  const user = maybeUser;
  const requestBodyText = await requestBodyTextPromise;
  debugSaveProxyRequest(requestBodyText);

  let requestBody: EditRequestBody;
  try {
    const { success, data, error } = EditRequestBody.safeParse(JSON.parse(requestBodyText));
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
    requestBody = data;
  } catch (e) {
    captureException(e, {
      extra: { kiloUserId: user.id },
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

  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ?? undefined;

  const promptInfo = extractEditPromptInfo(requestBody);

  const byokProviderKey: UserByokProviderId = 'inception';

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, [byokProviderKey])
    : await getBYOKforUser(readDb, user.id, [byokProviderKey]);

  const usageContext: MicrodollarUsageContext = {
    api_kind: 'edit_completions',
    kiloUserId: user.id,
    provider: editProvider,
    requested_model: requestBody.model,
    promptInfo,
    max_tokens: requestBody.max_tokens ?? null,
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
    feature: validateFeatureHeader(request.headers.get(FEATURE_HEADER)),
    session_id: taskId ?? null,
    mode: null,
    auto_model: null,
    ttfb_ms: null,
  };

  setTag('ui.ai_model', requestBody.model);

  // Use read replica for balance check - this is a read-only operation that can tolerate
  // slight replication lag, and provides lower latency for US users.
  const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user, readDb);

  if (balance <= 0 && !(await isFreeModel(requestBody.model)) && !userByok) {
    return NextResponse.json(
      {
        error: { message: 'Insufficient credits' },
        error_type: ProxyErrorType.insufficient_credits,
      },
      { status: 402 }
    );
  }

  const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
    modelId: requestBody.model,
    settings,
    organizationPlan: plan,
  });
  if (modelRestrictionError) return modelRestrictionError;

  // Org-level "do not collect my data" opt-out. The OpenRouter/Vercel paths
  // honor this by setting `provider.data_collection = 'deny'` on the upstream
  // request body, which causes the gateway to route to a sub-provider with a
  // no-training/no-retention contract. This route bypasses both gateways and
  // POSTs straight to Inception, and Inception's edit endpoint exposes no
  // per-request opt-out flag. Their public privacy policy
  // (https://www.inceptionlabs.ai/docs/privacy-policy) lists "Personal Data
  // contained in prompts, inputs and uploaded content processed by our models"
  // among the data they collect for purposes including "training and refining
  // our models"; "no training / no retention" is only offered as an enterprise
  // feature (https://www.inceptionlabs.ai/enterprise), not as the default for
  // the standard API tier we call here. Until we sign an enterprise agreement
  // or Inception adds a per-request flag, refusing is the only way to honor
  // the org's stated intent.
  if (providerConfig?.data_collection === 'deny') {
    return dataCollectionRequiredResponse();
  }

  if (providerConfig?.only && !providerConfig.only.includes(editProvider)) {
    return NextResponse.json(
      {
        error: 'Provider not allowed for your team.',
        error_type: ProxyErrorType.provider_not_allowed,
        message: `The provider "${editProvider}" is not allowed for your team.`,
      },
      { status: 403 }
    );
  }

  if (providerConfig?.ignore?.includes(editProvider)) {
    return NextResponse.json(
      {
        error: 'Provider not allowed for your team.',
        error_type: ProxyErrorType.provider_not_allowed,
        message: `The provider "${editProvider}" is not allowed for your team.`,
      },
      { status: 403 }
    );
  }

  const systemKey = getSystemApiKey(editProvider);
  const userByokEntry = userByok?.at(0);
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

  if (proxyRes.status >= 400) {
    await captureProxyError({
      user,
      request: bodyForUpstream,
      response: proxyRes,
      organizationId,
      model: requestBody.model,
      errorMessage: `Edit provider returned error ${proxyRes.status}`,
      trackInSentry: proxyRes.status >= 500,
    });
  }

  const clonedResponse = proxyRes.clone();

  countAndStoreEditUsage(clonedResponse, usageContext, requestSpan);

  return wrapInSafeNextResponse(proxyRes);
}
