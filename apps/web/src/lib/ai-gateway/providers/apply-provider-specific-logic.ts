import {
  isOpenRouterProviderConfig,
  type GatewayResponsesRequest,
  type OpenRouterChatCompletionRequest,
  type GatewayRequest,
  type GatewayMessagesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { applyMistralModelSettings, isMistralModel } from '@/lib/ai-gateway/providers/mistral';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { applyKiloExclusiveModelSettings } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@/lib/ai-gateway/providers/anthropic';
import {
  CLAUDE_OPUS_FALLBACK_MODEL_ID,
  isClaudeModel,
  isFableModel,
  isOpus5Model,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  applyMoonshotModelSettings,
  isKimiModel,
  PERPLEXITY_KIMI_PUBLIC_ID,
} from '@/lib/ai-gateway/providers/moonshotai';
import { FRIENDLI_GLM_PUBLIC_ID, isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import {
  ReasoningDetailsTransform,
  type BYOKResult,
  type Provider,
  type ProviderId,
} from '@/lib/ai-gateway/providers/types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import type { FraudDetectionHeaders } from '@/lib/utils';
import { applyTrackingIds } from '@/lib/ai-gateway/providerHash';
import {
  repairChatCompletionsTools,
  repairMessagesTools,
  sanitizeBinaryToolResults,
} from '@/lib/ai-gateway/tool-calling';
import { fixOpenCodeDuplicateReasoning } from '@/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import {
  addCacheBreakpoints,
  enableReasoningSummaries,
  fixResponsesRequest,
  isReasoningExplicitlyEnabled,
  mapReasoningDetailsToReasoningContent,
  scrubOpenCodeSpecificProperties,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { isQwenExplicitCacheModel, isQwenModel } from '@/lib/ai-gateway/providers/qwen';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';

export function getPreferredProviderOrder(requestedModel: string): string[] {
  if (isOpenAiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.openai];
  }
  if (isClaudeModel(requestedModel) && !isFableModel(requestedModel)) {
    // fable is not available on bedrock on vercel
    // and specifying bedrock breaks the opus fallback
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
    return [OpenRouterInferenceProviderIdSchema.enum.novita];
  }
  if (isGlmModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum.friendli,
      OpenRouterInferenceProviderIdSchema.enum.novita,
    ];
  }
  if (isQwenModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.alibaba];
  }
  return [];
}

export function applyPreferredProvider(
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
  if (!isOpenRouterProviderConfig(requestToMutate.provider)) {
    requestToMutate.provider = { order: preferredProviderOrder };
  } else if (!requestToMutate.provider.order) {
    requestToMutate.provider.order = preferredProviderOrder;
  }
}

export async function applyGatewayModelsFallback(
  providerId: ProviderId,
  requestedModel: string,
  requestToMutate: GatewayRequest
) {
  if (
    !(await isFreeModel(requestedModel)) &&
    (isFableModel(requestedModel) || isOpus5Model(requestedModel)) &&
    (providerId === 'openrouter' || providerId === 'vercel')
  ) {
    requestToMutate.body.models = [requestedModel, CLAUDE_OPUS_FALLBACK_MODEL_ID];
    return;
  }

  delete requestToMutate.body.models;
}

export function applyAnthropicThinkingDefault(
  requestedModel: string,
  requestToMutate: GatewayRequest
) {
  const defaultsToThinking =
    (isMinimaxModel(requestedModel) && requestedModel.includes('m3')) ||
    requestedModel === FRIENDLI_GLM_PUBLIC_ID ||
    requestedModel === PERPLEXITY_KIMI_PUBLIC_ID;
  if (
    defaultsToThinking &&
    requestToMutate.kind === 'messages' &&
    !isReasoningExplicitlyEnabled(requestToMutate)
  ) {
    // The Anthropic provider omits thinking:disabled when reasoning is not enabled, but these
    // models can default to thinking when the field is absent.
    requestToMutate.body.thinking = { type: 'disabled' };
  }
}

/**
 * Inverse of the reasoning-content response transform: folds
 * client-supplied `reasoning_details` back into the `reasoning_content` string
 * the upstream speaks, so reasoning survives the round trip.
 */
export function applyReasoningDetailsTransform(
  provider: Provider,
  requestToMutate: GatewayRequest
) {
  if (
    requestToMutate.kind === 'chat_completions' &&
    provider.responseTransforms === ReasoningDetailsTransform.ReasoningContent
  ) {
    mapReasoningDetailsToReasoningContent(requestToMutate.body);
  }
}

export async function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null,
  originalHeaders: FraudDetectionHeaders,
  userId: string,
  organizationId: string | null,
  sessionId: string | null,
  taskId: string | null
) {
  await applyGatewayModelsFallback(provider.id, requestedModel, requestToMutate);
  applyTrackingIds(requestToMutate, provider, userId, taskId);

  sanitizeBinaryToolResults(requestToMutate);

  if (requestToMutate.kind === 'chat_completions') {
    scrubOpenCodeSpecificProperties(requestToMutate.body);

    repairChatCompletionsTools(requestToMutate.body);

    applyReasoningDetailsTransform(provider, requestToMutate);

    if (isClaudeModel(requestedModel)) {
      // Workaround for older clients corrupting Claude reasoning, resulting in:
      // `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified
      fixOpenCodeDuplicateReasoning(requestedModel, requestToMutate.body, taskId ?? undefined);
    }
  }

  if (requestToMutate.kind === 'messages') {
    repairMessagesTools(requestToMutate.body);
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

  applyAnthropicThinkingDefault(requestedModel, requestToMutate);

  await provider.transformRequest({
    provider,
    model: requestedModel,
    request: requestToMutate,
    originalHeaders,
    extraHeaders,
    userByok,
    kilo_user_id: userId,
    organization_id: organizationId,
    session_id: sessionId,
  });
}
