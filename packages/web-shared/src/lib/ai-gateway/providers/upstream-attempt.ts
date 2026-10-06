import { after, type NextResponse } from 'next/server';

import {
  getToolsAvailable,
  getToolsUsed,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import {
  isChatGptUserNotEligible,
  OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/eligibility';
import { OPENAI_ON_BEHALF_OF_TOKEN_HEADER } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  clearOpenAiChatGptUsageLimit,
  markOpenAiChatGptNotEligible,
  recordOpenAiChatGptUsageLimit,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { readChatGptUsageLimit } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/usage-limit';
import { applyProviderSpecificLogic } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GetProviderProviderResult } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { upstreamRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import type { FraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';

type SendUpstreamAttemptInput = {
  providerContext: GetProviderProviderResult;
  requestedModel: string;
  request: GatewayRequest;
  fraudHeaders: FraudDetectionHeaders;
  userId: string;
  organizationId: string | null;
  sessionId: string | null;
  taskId: string | null;
  isNonTrialEnterprise: boolean;
  search: string;
  method: string;
  signal?: AbortSignal;
  vercelRequestId?: string | null;
};

type SendUpstreamAttemptResult =
  | { type: 'invalid-openrouter-model' }
  | { type: 'error'; response: NextResponse }
  | {
      type: 'success';
      response: Response;
      toolsAvailable: string[];
      toolsUsed: string[];
    };

/** Sends one upstream attempt and mutates the request with provider-specific transforms. */
export async function sendUpstreamAttempt({
  providerContext,
  requestedModel,
  request,
  fraudHeaders,
  userId,
  organizationId,
  sessionId,
  taskId,
  isNonTrialEnterprise,
  search,
  method,
  signal,
  vercelRequestId,
}: SendUpstreamAttemptInput): Promise<SendUpstreamAttemptResult> {
  const extraHeaders: Record<string, string> = {};
  await applyProviderSpecificLogic(
    providerContext.provider,
    requestedModel,
    request,
    extraHeaders,
    providerContext.userByok,
    fraudHeaders,
    userId,
    organizationId,
    sessionId,
    taskId,
    isNonTrialEnterprise
  );

  if (providerContext.provider.id === 'openrouter') {
    const transformedModel = request.body.model;
    if (!transformedModel || !(await isValidOpenRouterModelId(transformedModel))) {
      return { type: 'invalid-openrouter-model' };
    }
  }

  const result = await upstreamRequest({
    chatApi: request.kind,
    search,
    method,
    body: request.body,
    extraHeaders,
    provider: providerContext.provider,
    signal,
    vercelRequestId,
    reasoningEffort: getReasoningEffort(request),
  });
  if (result.type === 'error') return result;

  if (providerContext.provider.id === OPENAI_CHATGPT_PROVIDER_ID) {
    const owner = providerContext.provider.chatGptOwner;
    await syncChatGptUsageLimit(result.response, owner);
    await recordChatGptNotEligible(
      result.response,
      owner,
      extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER]
    );
  }

  return {
    type: 'success',
    response: result.response,
    toolsAvailable: getToolsAvailable(request),
    toolsUsed: getToolsUsed(request),
  };
}

/**
 * Keeps the stored ChatGPT plan limit in step with what the delegated upstream
 * says about it, so the web app can show the partner guideline's usage-limit
 * message while it applies and drop it as soon as it stops applying.
 *
 * A 429 records the limit. The response is cloned before it is read, so the
 * original body still streams to the caller unchanged. A response that
 * succeeded clears the record: OpenAI is the only authority on when the
 * allowance returns, and neither the recorded window nor a reconnect can know
 * that a person applied a reset in ChatGPT. The clear runs after the response,
 * so it never adds latency to a request that worked.
 *
 * The owner is the connection the provider named, so the record lands on the
 * exact row that served the request: the organization's shared-services
 * connection for a service run, and the caller's own row otherwise. Both
 * directions are best-effort: a database failure must never change the
 * request's outcome, which is the upstream response the caller already has.
 */
async function syncChatGptUsageLimit(
  response: Response,
  owner: OpenAiChatGptOwner | undefined
): Promise<void> {
  if (!owner) return;

  if (response.status < 400) {
    try {
      after(async () => {
        try {
          await clearOpenAiChatGptUsageLimit(owner);
        } catch {
          // Best-effort, exactly like the record path below.
        }
      });
    } catch {
      // `after` needs a request scope. Without one the request keeps its
      // outcome, and the next request through the connection clears the record.
    }
    return;
  }

  if (response.status !== 429) return;

  try {
    const limit = readChatGptUsageLimit(response.status, await response.clone().json());
    if (!limit) return;
    await recordOpenAiChatGptUsageLimit(owner, limit);
  } catch {
    // Best-effort: the caller still receives the upstream response.
  }
}

/**
 * Disables the connection when OpenAI refuses the connected account. OpenAI
 * says the same account fails every later request and every reconnect, so the
 * card must explain the restriction instead of letting the person retry. The
 * refused response still reaches the caller unchanged. Best-effort, like the
 * usage-limit record above.
 */
async function recordChatGptNotEligible(
  response: Response,
  owner: OpenAiChatGptOwner | undefined,
  accessToken: string | undefined
): Promise<void> {
  if (!owner || !accessToken || response.status !== 403) return;

  try {
    if (!isChatGptUserNotEligible(response.status, await response.clone().json())) return;
    await markOpenAiChatGptNotEligible(owner, accessToken, OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE);
  } catch {
    // Best-effort: the caller still receives the upstream response.
  }
}
