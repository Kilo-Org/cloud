import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  GatewayRequest,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { applyMistralModelSettings, isMistralModel } from '@/lib/ai-gateway/providers/mistral';
import { applyXaiModelSettings, isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { getInferenceProvider } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@/lib/ai-gateway/providers/anthropic';
import { isClaudeModel, isHaikuModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { hasAttemptCompletionTool } from '@/lib/ai-gateway/tool-calling';
import { applyGoogleModelSettings, isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { applyMoonshotModelSettings, isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import type { FraudDetectionHeaders } from '@/lib/utils';

function applyToolChoiceSetting(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (!hasAttemptCompletionTool(requestToMutate)) {
    return;
  }
  const isReasoningEnabled =
    (requestToMutate.reasoning?.enabled ?? false) === true ||
    (requestToMutate.reasoning?.effort ?? 'none') !== 'none' ||
    (requestToMutate.reasoning?.max_tokens ?? 0) > 0;
  if (
    isGrokModel(requestedModel) ||
    isOpenAiModel(requestedModel) ||
    isGeminiModel(requestedModel) ||
    (isHaikuModel(requestedModel) && !isReasoningEnabled)
  ) {
    console.debug('[applyToolChoiceSetting] setting tool_choice required');
    requestToMutate.tool_choice = 'required';
  }
}

function getPreferredProviderOrder(requestedModel: string): string[] {
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
    return [
      OpenRouterInferenceProviderIdSchema.enum.moonshotai,
      OpenRouterInferenceProviderIdSchema.enum.novita,
    ];
  }
  if (isStepModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.stepfun];
  }
  if (isDeepseekModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum.deepseek,
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
  originalHeaders: FraudDetectionHeaders
) {
  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  if (kiloExclusiveModel) {
    requestToMutate.body.model = kiloExclusiveModel.internal_id;
    const inferenceProvider = getInferenceProvider(kiloExclusiveModel);
    if (inferenceProvider) {
      if (requestToMutate.body.provider) {
        requestToMutate.body.provider.only = [inferenceProvider];
      } else {
        requestToMutate.body.provider = { only: [inferenceProvider] };
      }
    }
  }

  if (isClaudeModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (requestToMutate.kind === 'chat_completions') {
    applyToolChoiceSetting(requestedModel, requestToMutate.body);
  }

  if (provider.id === 'openrouter' || provider.id === 'vercel') {
    applyPreferredProvider(requestedModel, requestToMutate.body);
  }

  if (isGrokModel(requestedModel)) {
    applyXaiModelSettings(requestToMutate, extraHeaders);
  }

  if (isGeminiModel(requestedModel)) {
    applyGoogleModelSettings(provider.id, requestToMutate);
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
