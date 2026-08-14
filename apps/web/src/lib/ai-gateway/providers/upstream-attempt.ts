import type { NextResponse } from 'next/server';

import { buildExperimentPromptCapture } from '@/lib/ai-gateway/experiments/persist';
import { getToolsAvailable, getToolsUsed } from '@/lib/ai-gateway/o11y/api-metrics.server';
import type { ExperimentPromptCapture } from '@/lib/ai-gateway/processUsage.types';
import { sleepForRulesEngineAction } from '@/lib/ai-gateway/abuse-service';
import { applyProviderSpecificLogic } from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GetProviderProviderResult } from '@/lib/ai-gateway/providers/get-provider';
import { isValidOpenRouterModelId } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import type { FraudDetectionHeaders } from '@/lib/utils';

type SendUpstreamAttemptInput = {
  providerContext: GetProviderProviderResult;
  requestedModel: string;
  request: GatewayRequest;
  fraudHeaders: FraudDetectionHeaders;
  userId: string;
  organizationId: string | null;
  sessionId: string | null;
  taskId: string | null;
  delayMs: number;
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
      experimentPromptCapture?: ExperimentPromptCapture;
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
  delayMs,
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

  const experimentPromptCapture = providerContext.experiment
    ? buildExperimentPromptCapture(request)
    : undefined;

  if (delayMs > 0) {
    await sleepForRulesEngineAction(delayMs);
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
  });
  if (result.type === 'error') return result;

  return {
    type: 'success',
    response: result.response,
    toolsAvailable: getToolsAvailable(request),
    toolsUsed: getToolsUsed(request),
    experimentPromptCapture,
  };
}
