import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  GatewayRequest,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { applyMistralModelSettings, isMistralModel } from '@/lib/ai-gateway/providers/mistral';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { applyKiloExclusiveModelSettings } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@/lib/ai-gateway/providers/anthropic';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  isClaudeModel,
  isFableModel,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { applyMoonshotModelSettings, isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import type { BYOKResult, Provider, ProviderId } from '@/lib/ai-gateway/providers/types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import { isOpenCodeBasedClient, type FraudDetectionHeaders } from '@/lib/utils';
import { applyTrackingIds } from '@/lib/ai-gateway/providerHash';
import { repairTools, sanitizeBinaryToolResults } from '@/lib/ai-gateway/tool-calling';
import { fixOpenCodeDuplicateReasoning } from '@/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import {
  addCacheBreakpoints,
  enableReasoningSummaries,
  fixResponsesRequest,
  scrubOpenCodeSpecificProperties,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { isQwenExplicitCacheModel, isQwenModel } from '@/lib/ai-gateway/providers/qwen';

export function getPreferredProviderOrder(requestedModel: string): string[] {
  if (isClaudeModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
      OpenRouterInferenceProviderIdSchema.enum.anthropic,
    ];
  }
  if (isMinimaxModel(requestedModel)) {
    return ['minimax/fp8']; // do not prefer minimax/highspeed
  }
  if (isMistralModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.mistral];
  }
  if (isKimiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.novita];
  }
  if (isStepModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.stepfun];
  }
  if (isDeepseekModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum.alibaba,
      OpenRouterInferenceProviderIdSchema.enum.novita,
    ];
  }
  if (isGlmModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum.friendli,
      OpenRouterInferenceProviderIdSchema.enum.novita,
      OpenRouterInferenceProviderIdSchema.enum['z-ai'],
    ];
  }
  if (isQwenModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.alibaba];
  }
  return [];
}

function applyPreferredProvider(
  requestedModel: string,
  requestToMutate:
    | OpenRouterChatCompletionRequest
    | GatewayResponsesRequest
    | GatewayMessagesRequest
) {
  const preferredProviderOrder = getPreferredProviderOrder(requestedModel);
  if (preferredProviderOrder.length === 0) {
    return;
  }
  console.debug(
    `[applyPreferredProvider] Preferentially routing ${requestedModel} to ${preferredProviderOrder.join()}`
  );
  if (!requestToMutate.provider) {
    requestToMutate.provider = { order: preferredProviderOrder };
  } else if (!requestToMutate.provider.order) {
    requestToMutate.provider.order = preferredProviderOrder;
  }
}

export function applyGatewayModelsFallback(
  providerId: ProviderId,
  requestedModel: string,
  requestToMutate: GatewayRequest
) {
  if (isFableModel(requestedModel) && (providerId === 'openrouter' || providerId === 'vercel')) {
    requestToMutate.body.models = [requestedModel, CLAUDE_OPUS_CURRENT_MODEL_ID];
    return;
  }

  delete requestToMutate.body.models;
}

export function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null,
  originalHeaders: FraudDetectionHeaders,
  userId: string,
  taskId: string | null
) {
  applyGatewayModelsFallback(provider.id, requestedModel, requestToMutate);
  applyTrackingIds(requestToMutate, provider, userId, taskId);

  sanitizeBinaryToolResults(requestToMutate);

  if (requestToMutate.kind === 'chat_completions') {
    scrubOpenCodeSpecificProperties(requestToMutate.body);

    // Mostly a workaround for bugs in the old extension.
    repairTools(requestToMutate.body);

    if (isOpenCodeBasedClient(originalHeaders)) {
      // Workaround for bugs in the chat completions client.
      fixOpenCodeDuplicateReasoning(requestedModel, requestToMutate.body, taskId ?? undefined);
    }
  }

  if (requestToMutate.kind === 'responses') {
    fixResponsesRequest(requestToMutate.body);
  }

  enableReasoningSummaries(requestToMutate);

  const kiloExclusiveModel = findKiloExclusiveModel(requestedModel);
  if (kiloExclusiveModel) {
    applyKiloExclusiveModelSettings(requestToMutate, kiloExclusiveModel);
  }

  if (isClaudeModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (provider.id === 'openrouter' || provider.id === 'vercel') {
    applyPreferredProvider(requestedModel, requestToMutate.body);
  }

  if (isKimiModel(requestedModel)) {
    applyMoonshotModelSettings(requestToMutate);
  }

  if (isMistralModel(requestedModel)) {
    applyMistralModelSettings(requestToMutate);
  }

  if (isQwenExplicitCacheModel(requestedModel)) {
    addCacheBreakpoints(requestToMutate);
  }

  provider.transformRequest({
    provider,
    model: requestedModel,
    request: requestToMutate,
    originalHeaders,
    extraHeaders,
    userByok,
  });
}
