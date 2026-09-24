import type { NextResponse } from 'next/server';

import { OPENAI_CHATGPT_PROVIDER_ID } from '@/lib/ai-gateway/openai-chatgpt/provider-id';
import {
  hasOpenAiChatGptSharedServicesConnection,
  openAiChatGptSharedServicesOwner,
  recordOpenAiChatGptUsageLimit,
  type OpenAiChatGptOwner,
} from '@/lib/ai-gateway/openai-chatgpt/store';
import { readChatGptUsageLimit } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';
import { applyProviderSpecificLogic } from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GetProviderProviderResult } from '@/lib/ai-gateway/providers/get-provider';
import { isValidOpenRouterModelId } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { getReasoningEffort } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import type { FraudDetectionHeaders } from '@/lib/utils';

type SendUpstreamAttemptInput = {
  providerContext: GetProviderProviderResult;
  requestedModel: string;
  request: GatewayRequest;
  fraudHeaders: FraudDetectionHeaders;
  userId: string;
  organizationId: string | null;
  /** The platform caller for a service run, when there is one. */
  botId?: string | undefined;
  sessionId: string | null;
  taskId: string | null;
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
    };

/** Sends one upstream attempt and mutates the request with provider-specific transforms. */
export async function sendUpstreamAttempt({
  providerContext,
  requestedModel,
  request,
  fraudHeaders,
  userId,
  organizationId,
  botId,
  sessionId,
  taskId,
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
    taskId
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
    await recordChatGptUsageLimitIfReached(result.response, { userId, organizationId, botId });
  }

  return {
    type: 'success',
    response: result.response,
  };
}

/**
 * Records a ChatGPT plan limit so the web app can show the partner guideline's
 * usage-limit message on the next page load. The response is cloned before it
 * is read, so the original body still streams to the caller unchanged, and
 * recording is best-effort: a database failure must never change the request's
 * outcome, which is the upstream error the caller already has.
 */
async function recordChatGptUsageLimitIfReached(
  response: Response,
  owner: { userId: string; organizationId: string | null; botId?: string | undefined }
): Promise<void> {
  if (response.status !== 429) return;

  try {
    const limit = readChatGptUsageLimit(response.status, await response.clone().json());
    if (!limit) return;
    await recordOpenAiChatGptUsageLimit(await resolveUsageLimitOwner(owner), limit);
  } catch {
    // Best-effort: the caller still receives the upstream response.
  }
}

/**
 * The row a reported plan limit belongs to. A service request records on the
 * organization's shared-services connection when one is stored, because routing
 * would have served the request from it. Every other request records on the
 * caller's own connection, which is what routing would have used.
 */
async function resolveUsageLimitOwner(owner: {
  userId: string;
  organizationId: string | null;
  botId?: string | undefined;
}): Promise<OpenAiChatGptOwner> {
  if (
    owner.botId &&
    owner.organizationId &&
    (await hasOpenAiChatGptSharedServicesConnection(owner.organizationId))
  ) {
    return openAiChatGptSharedServicesOwner(owner.organizationId);
  }
  return { kiloUserId: owner.userId, organizationId: owner.organizationId };
}
