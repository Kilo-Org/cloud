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
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { applyMoonshotModelSettings, isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import { isOpenCodeBasedClient, type FraudDetectionHeaders } from '@/lib/utils';
import { applyTrackingIds } from '@/lib/ai-gateway/providerHash';
import { repairTools, sanitizeBinaryToolResults } from '@/lib/ai-gateway/tool-calling';
import { fixOpenCodeDuplicateReasoning } from '@/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import {
  enableReasoningSummaries,
  fixResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';

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
      OpenRouterInferenceProviderIdSchema.enum.novita,
      OpenRouterInferenceProviderIdSchema.enum['z-ai'],
    ];
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
  applyTrackingIds(requestToMutate, provider, userId, taskId);

  sanitizeBinaryToolResults(requestToMutate);

  if (requestToMutate.kind === 'chat_completions') {
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

  provider.transformRequest({
    model: requestedModel,
    request: requestToMutate,
    originalHeaders,
    extraHeaders,
    userByok,
  });
}
