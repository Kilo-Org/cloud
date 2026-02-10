import { MISTRAL_API_KEY } from '@/lib/config.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import z from 'zod';
import { captureException, setTag, startInactiveSpan } from '@sentry/nextjs';
import type { MicrodollarUsageContext } from '@/lib/processUsage';
import { isFreeModel } from '@/lib/models';
import { sentryRootSpan } from '@/lib/getRootSpan';
import { getUserFromAuth } from '@/lib/user.server';
import {
  checkOrganizationModelRestrictions,
  countAndStoreFimUsage,
  estimateFimTokens,
  extractFimPromptInfo,
  extractFraudAndProjectHeaders,
  invalidRequestResponse,
  temporarilyUnavailableResponse,
  usageLimitExceededResponse,
  wrapInSafeNextResponse,
  captureProxyError,
  extractHeaderAndLimitLength,
} from '@/lib/llm-proxy-helpers';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';
import { debugSaveProxyRequest } from '@/lib/debugUtils';
import { sentryLogger } from '@/lib/utils.server';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/byok';

const MISTRAL_URL = 'https://api.mistral.ai/v1/fim/completions';
const FIM_MAX_TOKENS_LIMIT = 1000;

const FIMRequestBody = z.object({
  //ref: https://docs.mistral.ai/api/endpoint/fim#operation-fim_completion_v1_fim_completions_post
  provider: z.enum(['mistral', 'inceptionlabs']).optional(),
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

  if ((requestBody.provider ?? 'mistral') !== 'mistral') {
    return NextResponse.json(
      { error: requestBody.provider + ' provider not yet supported' },
      { status: 400 }
    );
    //NOTE: mistral does not do data collection on paid org accounts like ours.
    //If we ever support OTHER providers, we need to either ensure they don't
    //either, or at least enforce the rules the org settings configure
    //see getBalanceAndOrgSettings below and its usage in the openrouter proxy.
    //ref: https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models
  }

  // Validate max_tokens
  if (!requestBody.max_tokens || requestBody.max_tokens > FIM_MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: FIM Max tokens limit exceeded or missing: ${user.id}`, {
      maxTokens: requestBody.max_tokens,
    });
    return temporarilyUnavailableResponse();
  }

  // Map FIM model to OpenRouter format for org settings compatibility
  const fimModel_withOpenRouterStyleProviderPrefix = requestBody.model;

  const requiredModelPrefix = 'mistralai/';
  if (!fimModel_withOpenRouterStyleProviderPrefix.startsWith(requiredModelPrefix)) {
    return NextResponse.json(
      { error: fimModel_withOpenRouterStyleProviderPrefix + ' is not a mistralai model' },
      { status: 400 }
    );
  }

  const mistralModel = fimModel_withOpenRouterStyleProviderPrefix.slice(requiredModelPrefix.length);

  // Use new shared helper for fraud & project headers
  const { fraudHeaders, projectId } = extractFraudAndProjectHeaders(request);

  // Extract properties for usage context
  const tokenEstimates = estimateFimTokens(requestBody);
  const promptInfo = extractFimPromptInfo(requestBody);

  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, 'codestral')
    : await getBYOKforUser(readDb, user.id, 'codestral');

  const usageContext: MicrodollarUsageContext = {
    kiloUserId: user.id,
    provider: 'mistral',
    requested_model: fimModel_withOpenRouterStyleProviderPrefix,
    promptInfo,
    max_tokens: requestBody.max_tokens ?? null,
    has_middle_out_transform: null, // N/A for FIM
    estimatedInputTokens: tokenEstimates.estimatedInputTokens,
    estimatedOutputTokens: tokenEstimates.estimatedOutputTokens,
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
  };

  setTag('ui.ai_model', fimModel_withOpenRouterStyleProviderPrefix);
  // Use read replica for balance check - this is a read-only operation that can tolerate
  // slight replication lag, and provides lower latency for US users
  const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user, readDb);

  if (balance <= 0 && !isFreeModel(fimModel_withOpenRouterStyleProviderPrefix) && !userByok) {
    return await usageLimitExceededResponse(user, balance);
  }

  // Use shared helper for organization model restrictions
  // Model allow list only applies to Enterprise plans
  // Provider allow list applies to Enterprise plans; data collection applies to all plans (but FIM doesn't use provider config)
  const { error: modelRestrictionError } = checkOrganizationModelRestrictions({
    modelId: fimModel_withOpenRouterStyleProviderPrefix,
    settings,
    organizationPlan: plan,
  });
  if (modelRestrictionError) return modelRestrictionError;

  sentryRootSpan()?.setAttribute(
    'mistral-fim.time_to_request_start_ms',
    performance.now() - requestStartedAt
  );

  const mistralRequestSpan = startInactiveSpan({
    name: 'mistral-fim-request-start',
    op: 'http.client',
  });

  const bodyWithCorrectedModel = { ...requestBody, model: mistralModel };
  // Make upstream request to Mistral
  const proxyRes = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userByok?.decryptedAPIKey ?? MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(bodyWithCorrectedModel),
  });
  usageContext.status_code = proxyRes.status;

  if (!proxyRes.body) {
    return NextResponse.json({ error: 'No body returned from upstream' }, { status: 500 });
  }

  // Handle errors
  if (proxyRes.status >= 400) {
    await captureProxyError({
      user,
      request: bodyWithCorrectedModel,
      response: proxyRes,
      organizationId,
      model: fimModel_withOpenRouterStyleProviderPrefix,
      errorMessage: `Mistral FIM returned error ${proxyRes.status}`,
      trackInSentry: proxyRes.status >= 500,
    });
  }

  const clonedResponse = proxyRes.clone(); // reading from body is side-effectful

  // Account for usage using FIM-specific parser
  countAndStoreFimUsage(clonedResponse, usageContext, mistralRequestSpan);

  return wrapInSafeNextResponse(proxyRes);
}
