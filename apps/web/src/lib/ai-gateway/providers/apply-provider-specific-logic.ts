import type {
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
  GatewayRequest,
  GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { applyMistralModelSettings, isMistralModel } from '@/lib/ai-gateway/providers/mistral';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { applyKiloExclusiveModelSettings } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@/lib/ai-gateway/providers/anthropic';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { applyGoogleModelSettings, isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { applyMoonshotModelSettings, isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import type { FraudDetectionHeaders } from '@/lib/utils';

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

export type ApplyProviderSpecificLogicOptions = {
  /**
   * When true, skip the kilo-exclusive `internal_id` rewrite + provider pin
   * normally applied to public ids registered in `kiloExclusiveModels`.
   * Generic provider-specific request fixes and `provider.transformRequest`
   * still run.
   *
   * Set by experiment routing because the partner upstream is selected by
   * the variant version, not by the registry.
   */
  skipKiloExclusiveModelSettings?: boolean;
};

export function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null,
  originalHeaders: FraudDetectionHeaders,
  options: ApplyProviderSpecificLogicOptions = {}
) {
  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  if (kiloExclusiveModel && !options.skipKiloExclusiveModelSettings) {
    applyKiloExclusiveModelSettings(requestToMutate, kiloExclusiveModel);
  }

  if (isClaudeModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (provider.id === 'openrouter' || provider.id === 'vercel') {
    applyPreferredProvider(requestedModel, requestToMutate.body);
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
