import type { Context } from 'hono';
import type { HonoEnv } from '../types.js';
import {
  type OpenRouterChatCompletionRequest,
  type MicrodollarUsageContext,
  type AnonymousUserContext,
  isKiloAutoModel,
  resolveAutoModel,
  isKiloFreeModel,
  isFreeModel,
  isDeadFreeModel,
  isDataCollectionRequiredOnKiloCodeOnly,
  isRateLimitedToDeath,
  isActiveReviewPromo,
  isActiveCloudAgentPromo,
  normalizeModelId,
  generateProviderSpecificHash,
  extractPromptInfo,
  estimateChatTokens,
  validateFeatureHeader,
  FEATURE_HEADER,
  ENABLE_TOOL_REPAIR,
  repairTools,
  isFreePromptTrainingAllowed,
  checkOrganizationModelRestrictions,
  applyProviderSpecificLogic,
  getToolsAvailable,
  getToolsUsed,
  createAnonymousContext,
  isAnonymousContext,
  PROMOTION_MAX_REQUESTS,
  PROMOTION_WINDOW_HOURS,
} from '@kilocode/llm-shared';
import type { User } from '@kilocode/db/schema';
import {
  invalidRequestResponse,
  temporarilyUnavailableResponse,
  rateLimitExceededResponse,
  paidModelAuthRequiredResponse,
  promotionLimitReachedResponse,
  dataCollectionRequiredResponse,
  alphaPeriodEndedResponse,
  modelDoesNotExistResponse,
  modelNotAllowedResponse,
  ipRequiredResponse,
  wrapResponse,
} from '../responses.js';
import { getWorkerDb } from '../lib/db.js';
import { authenticateRequest } from '../services/auth.js';
import { getProvider, createProviders } from '../services/provider.js';
import { getBalanceAndOrgSettings } from '../services/balance.js';
import {
  checkFreeModelRateLimit,
  logFreeModelRequest,
  checkPromotionLimit,
} from '../services/rate-limit.js';
import { upstreamRequest } from '../services/upstream.js';
import { classifyAbuse } from '../services/abuse.js';
import { customLlmRequest } from '../services/custom-llm.js';
import { countAndStoreUsage } from '../background/usage-accounting.js';
import { captureProxyError } from '../background/error-capture.js';
import { logger } from '../logger.js';

const MAX_TOKENS_LIMIT = 99999999999;

export async function handleChatCompletions(c: Context<HonoEnv>): Promise<Response> {
  const requestStartedAt = performance.now();
  const env = c.env;

  // 1. Parse & validate request body
  let requestBodyParsed: OpenRouterChatCompletionRequest;
  try {
    const text = await c.req.text();
    requestBodyParsed = JSON.parse(text);
    requestBodyParsed.stream_options = {
      ...(requestBodyParsed.stream_options || {}),
      include_usage: true,
    };
  } catch {
    return invalidRequestResponse();
  }

  delete requestBodyParsed.models;
  if (typeof requestBodyParsed.model !== 'string' || requestBodyParsed.model.trim().length === 0) {
    return modelDoesNotExistResponse();
  }

  const requestedModel = requestBodyParsed.model.trim();
  const requestedModelLowerCased = requestedModel.toLowerCase();

  // 2. Auto-model resolution
  if (isKiloAutoModel(requestedModelLowerCased)) {
    const modeHeader = c.req.header('x-kilocode-mode') ?? null;
    Object.assign(requestBodyParsed, resolveAutoModel(requestedModelLowerCased, modeHeader));
  }

  const originalModelIdLowerCased = requestBodyParsed.model.toLowerCase();

  // 3. IP extraction — prefer CF-Connecting-IP, fall back to X-Forwarded-For
  const ipAddress =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ipAddress) {
    return ipRequiredResponse();
  }

  // Set up DB connection via Hyperdrive
  const { db, connect, end } = getWorkerDb(env.HYPERDRIVE.connectionString);
  await connect();

  try {
    // 4. Free model rate limit
    if (isKiloFreeModel(originalModelIdLowerCased)) {
      const rateLimitResult = await checkFreeModelRateLimit(ipAddress, db);
      if (!rateLimitResult.allowed) {
        logger.warn('Free model rate limit exceeded', {
          model: originalModelIdLowerCased,
        });
        return rateLimitExceededResponse();
      }
    }

    // 5. Auth — JWT only
    const authResult = await authenticateRequest(
      c.req.header('authorization'),
      c.req.header('x-kilocode-organizationid'),
      db,
      env.NEXTAUTH_SECRET
    );

    let user: User | AnonymousUserContext;
    let organizationId: string | undefined;
    let botId: string | undefined;
    let tokenSource: string | undefined;

    if ('error' in authResult) {
      // 6. Anonymous fallback for free models
      if (!isFreeModel(originalModelIdLowerCased)) {
        return paidModelAuthRequiredResponse();
      }

      const promotionLimit = await checkPromotionLimit(
        ipAddress,
        PROMOTION_MAX_REQUESTS,
        PROMOTION_WINDOW_HOURS,
        db
      );
      if (!promotionLimit.allowed) {
        return promotionLimitReachedResponse();
      }

      user = createAnonymousContext(ipAddress);
      organizationId = undefined;
      botId = undefined;
      tokenSource = undefined;
    } else {
      user = authResult.user;
      organizationId = authResult.organizationId;
      botId = authResult.botId;
      tokenSource = authResult.tokenSource;
    }

    // 7. Free model request logging
    if (isKiloFreeModel(originalModelIdLowerCased)) {
      await logFreeModelRequest(
        ipAddress,
        originalModelIdLowerCased,
        isAnonymousContext(user) ? undefined : user.id,
        db
      );
    }

    // 8. Provider selection
    const providers = createProviders({ openrouterApiKey: env.OPENROUTER_API_KEY });
    const taskId = c.req.header('x-kilocode-taskid')?.slice(0, 500)?.trim() || undefined;
    const {
      provider,
      userByok,
      customLlm: customLlmRecord,
    } = await getProvider(
      originalModelIdLowerCased,
      requestBodyParsed,
      user,
      organizationId,
      taskId,
      db,
      providers
    );

    logger.debug(`Routing request to ${provider.id}`, { provider: provider.id });

    // 9. Abuse classification (non-blocking, 2s timeout)
    const classifyPromise = classifyAbuse(c.req.raw, requestBodyParsed, {
      kiloUserId: user.id,
      organizationId,
      projectId: c.req.header('x-kilocode-projectid')?.slice(0, 500)?.trim() || null,
      provider: provider.id,
      isByok: !!userByok,
    });

    // 10. Max tokens check
    if (requestBodyParsed.max_tokens && requestBodyParsed.max_tokens > MAX_TOKENS_LIMIT) {
      logger.warn('Max tokens limit exceeded', { userId: user.id });
      return temporarilyUnavailableResponse();
    }

    // 11. Dead/rate-limited model checks
    if (isDeadFreeModel(originalModelIdLowerCased)) {
      return alphaPeriodEndedResponse();
    }
    if (isRateLimitedToDeath(originalModelIdLowerCased)) {
      return modelDoesNotExistResponse();
    }

    // 12. Balance/org checks
    const tokenEstimates = estimateChatTokens(requestBodyParsed);
    const promptInfo = extractPromptInfo(requestBodyParsed);

    // Extract fraud detection headers
    const fraudHeaders = {
      http_x_forwarded_for: c.req.header('x-forwarded-for') || null,
      http_x_vercel_ip_city: c.req.header('x-vercel-ip-city') || null,
      http_x_vercel_ip_country: c.req.header('x-vercel-ip-country') || null,
      http_x_vercel_ip_latitude: c.req.header('x-vercel-ip-latitude')
        ? Number(c.req.header('x-vercel-ip-latitude'))
        : null,
      http_x_vercel_ip_longitude: c.req.header('x-vercel-ip-longitude')
        ? Number(c.req.header('x-vercel-ip-longitude'))
        : null,
      http_x_vercel_ja4_digest: c.req.header('x-vercel-ja4-digest') || null,
      http_user_agent: c.req.header('user-agent') || null,
    };

    const projectId = c.req.header('x-kilocode-projectid')?.slice(0, 500)?.trim() || null;

    const usageContext: MicrodollarUsageContext = {
      kiloUserId: user.id,
      provider: provider.id,
      requested_model: originalModelIdLowerCased,
      promptInfo,
      max_tokens: requestBodyParsed.max_tokens ?? null,
      has_middle_out_transform: requestBodyParsed.transforms?.includes('middle-out') ?? false,
      estimatedInputTokens: tokenEstimates.estimatedInputTokens,
      estimatedOutputTokens: tokenEstimates.estimatedOutputTokens,
      fraudHeaders,
      isStreaming: requestBodyParsed.stream === true,
      organizationId,
      prior_microdollar_usage: isAnonymousContext(user) ? 0 : user.microdollars_used,
      posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
      project_id: projectId,
      status_code: null,
      editor_name: c.req.header('x-kilocode-editorname')?.slice(0, 500)?.trim() || null,
      machine_id: c.req.header('x-kilocode-machineid')?.slice(0, 500)?.trim() || null,
      user_byok: !!userByok,
      has_tools: (requestBodyParsed.tools?.length ?? 0) > 0,
      botId,
      tokenSource,
      feature: validateFeatureHeader(c.req.header(FEATURE_HEADER) ?? null),
      session_id: taskId ?? null,
    };

    const bypassAccessCheckForCustomLlm =
      !!customLlmRecord &&
      !!organizationId &&
      customLlmRecord.organization_ids.includes(organizationId);

    if (!isAnonymousContext(user) && !bypassAccessCheckForCustomLlm) {
      const { balance, settings, plan } = await getBalanceAndOrgSettings(organizationId, user, db);

      if (
        balance <= 0 &&
        !isFreeModel(originalModelIdLowerCased) &&
        !userByok &&
        !isActiveReviewPromo(botId, originalModelIdLowerCased) &&
        !isActiveCloudAgentPromo(tokenSource, originalModelIdLowerCased)
      ) {
        // TODO: Port full usageLimitExceededResponse with payment history
        return Response.json(
          {
            error: {
              title: 'Low Credit Warning!',
              message: 'Add credits to continue, or switch to a free model',
              balance,
              buyCreditsUrl: 'https://app.kilo.ai/profile',
            },
          },
          { status: 402 }
        );
      }

      const { error: modelRestrictionError, providerConfig } = checkOrganizationModelRestrictions({
        modelId: originalModelIdLowerCased,
        settings,
        organizationPlan: plan,
      });
      if (modelRestrictionError) {
        return modelNotAllowedResponse();
      }

      if (providerConfig) {
        requestBodyParsed.provider = providerConfig;
      }
    }

    // 13. Provider-specific mutations
    if (
      isDataCollectionRequiredOnKiloCodeOnly(originalModelIdLowerCased) &&
      !isFreePromptTrainingAllowed(requestBodyParsed.provider)
    ) {
      return dataCollectionRequiredResponse();
    }

    // 14. Prompt cache key + safety identifier
    if (taskId) {
      requestBodyParsed.prompt_cache_key = generateProviderSpecificHash(user.id + taskId, provider);
    }
    requestBodyParsed.safety_identifier = generateProviderSpecificHash(user.id, provider);
    requestBodyParsed.user = requestBodyParsed.safety_identifier;

    // 15. Tool repair
    if (ENABLE_TOOL_REPAIR) {
      repairTools(requestBodyParsed);
    }

    const toolsAvailable = getToolsAvailable(requestBodyParsed.tools);
    const toolsUsed = getToolsUsed(requestBodyParsed.messages);

    const extraHeaders: Record<string, string> = {};
    applyProviderSpecificLogic(
      provider,
      originalModelIdLowerCased,
      requestBodyParsed,
      extraHeaders,
      userByok
    );

    // 16. Upstream request
    const response = customLlmRecord
      ? await customLlmRequest(
          customLlmRecord,
          requestBodyParsed,
          user.id,
          taskId,
          !!fraudHeaders.http_user_agent?.startsWith('Kilo-Code/')
        )
      : await upstreamRequest({
          path: '/chat/completions',
          search: '',
          method: 'POST',
          body: requestBodyParsed,
          extraHeaders,
          provider,
        });

    const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
    usageContext.status_code = response.status;

    // 17. Response processing — background tasks via ctx.waitUntil()

    // Await abuse classification (with 2s timeout)
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const classifyResult = await Promise.race([
      classifyPromise.finally(() => timeoutId && clearTimeout(timeoutId)),
      new Promise<null>(resolve => {
        timeoutId = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    if (classifyResult) {
      usageContext.abuse_request_id = classifyResult.request_id;
    }

    // Background: usage accounting
    const clonedResponse = response.clone();
    c.executionCtx.waitUntil(countAndStoreUsage(clonedResponse, usageContext));

    // Background: error capture
    if (response.status === 402 && !userByok) {
      c.executionCtx.waitUntil(
        captureProxyError({
          errorMessage: `${provider.id} returned 402 Payment Required`,
          userId: user.id,
          response: response.clone(),
          organizationId,
          model: requestBodyParsed.model,
          trackInSentry: true,
        })
      );
      return temporarilyUnavailableResponse();
    }

    if (response.status >= 400) {
      c.executionCtx.waitUntil(
        captureProxyError({
          errorMessage: `${provider.id} returned error ${response.status}`,
          userId: user.id,
          response: response.clone(),
          organizationId,
          model: requestBodyParsed.model,
          trackInSentry: response.status >= 500,
        })
      );
    }

    // Return response to client
    return wrapResponse(response);
  } finally {
    // Clean up DB connection
    await end().catch(() => {});
  }
}
