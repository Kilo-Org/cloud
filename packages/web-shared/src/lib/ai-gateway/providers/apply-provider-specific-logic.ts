import {
  isOpenRouterProviderConfig,
  type GatewayResponsesRequest,
  type OpenRouterChatCompletionRequest,
  type GatewayRequest,
  type GatewayMessagesRequest,
  type OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  applyMistralModelSettings,
  isMistralModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { applyVercelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  applyKiloExclusiveModelSettings,
  type KiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { OpenRouterInferenceProviderIdSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  applyMoonshotModelSettings,
  isKimiModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/moonshotai';
import { isGlmModel } from '@kilocode/web-shared/lib/ai-gateway/providers/zai';
import { isMinimaxModel } from '@kilocode/web-shared/lib/ai-gateway/providers/minimax';
import {
  ReasoningDetailsTransform,
  type BYOKResult,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { isStepModel } from '@kilocode/web-shared/lib/ai-gateway/providers/stepfun';
import { isDeepseekModel } from '@kilocode/web-shared/lib/ai-gateway/providers/deepseek';
import type { FraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { isAnonymousUserId } from '@kilocode/web-shared/lib/anonymous';
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  repairChatCompletionsTools,
  repairMessagesTools,
  sanitizeBinaryToolResults,
} from '@kilocode/web-shared/lib/ai-gateway/tool-calling';
import { fixOpenCodeDuplicateReasoning } from '@kilocode/web-shared/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import {
  addCacheBreakpoints,
  enableReasoningSummaries,
  fixResponsesRequest,
  mapReasoningDetailsToReasoningContent,
  scrubOpenCodeSpecificProperties,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import {
  isQwenExplicitCacheModel,
  isQwenModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/qwen';
import { isOpenAiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openai';
import { ReasoningFormat } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/format';
import { ReasoningDetailType } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';
import { getCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { sanitizeJsonRefToolResults } from '@kilocode/web-shared/lib/ai-gateway/providers/sanitize-json-ref-tool-results';
import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import { removeRecursiveToolSchemaRefs } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-recursive-tool-schema-refs';
import { removeTopLevelToolSchemaCombinators } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-top-level-tool-schema-combinators';
import {
  addReflectionReasoningPlaceholders,
  isReflectionModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reflection';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setGeminiThoughtSignature(value: Record<string, unknown>, signature: string) {
  const extraContent = isRecord(value.extra_content) ? value.extra_content : {};
  const google = isRecord(extraContent.google) ? extraContent.google : {};
  value.extra_content = {
    ...extraContent,
    google: {
      ...google,
      thought_signature: signature,
    },
  };
}

function mapGeminiReasoningDetails(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;
    delete message.reasoning;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    for (const toolCall of toolCalls) {
      const legacySignature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof legacySignature === 'string') {
        setGeminiThoughtSignature(toolCall, legacySignature);
      }
    }

    const reasoningDetails = message.reasoning_details;
    delete message.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      continue;
    }

    for (const detail of reasoningDetails) {
      if (
        !isRecord(detail) ||
        detail.type !== ReasoningDetailType.Encrypted ||
        typeof detail.data !== 'string' ||
        detail.format !== ReasoningFormat.GoogleGeminiV1
      ) {
        continue;
      }

      const toolCall =
        typeof detail.id === 'string'
          ? toolCalls.find(candidate => candidate.id === detail.id)
          : undefined;
      setGeminiThoughtSignature(toolCall ?? message, detail.data);
    }
  }
}

function applyGeminiReasoningTransform(request: OpenRouterChatCompletionRequest) {
  const reasoningEffort = request.reasoning_effort;
  const extra = request as typeof request & { google?: unknown };
  delete extra.reasoning_effort;

  if (reasoningEffort !== 'none') {
    const existingGoogle = isRecord(extra.google) ? extra.google : {};
    extra.google = {
      ...existingGoogle,
      thinking_config: {
        ...(reasoningEffort !== undefined ? { thinking_level: reasoningEffort } : {}),
        include_thoughts: true,
      },
    };
  }

  mapGeminiReasoningDetails(request);
}

export function getPreferredProviderOrder(requestedModel: string): string[] {
  if (isOpenAiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.openai];
  }
  if (isClaudeModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum['google-vertex'],
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
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
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
      OpenRouterInferenceProviderIdSchema.enum.alibaba,
    ];
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

/**
 * Claude goes to Anthropic directly only for non-trial enterprise
 * organizations; everyone else is served by the other Claude providers.
 */
export function getIgnoredProviders(
  requestedModel: string,
  isAnthropicProviderAllowed: boolean
): string[] {
  if (!isAnthropicProviderAllowed && isClaudeModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.anthropic];
  }
  return [];
}

export function withIgnoredProviders(
  provider: OpenRouterProviderConfig | undefined,
  ignoredProviders: string[]
): OpenRouterProviderConfig | undefined {
  if (ignoredProviders.length === 0) {
    return provider;
  }
  return { ...provider, ignore: [...new Set([...(provider?.ignore ?? []), ...ignoredProviders])] };
}

export function applyPreferredProvider(
  requestedModel: string,
  requestToMutate:
    | OpenRouterChatCompletionRequest
    | GatewayResponsesRequest
    | GatewayMessagesRequest,
  isAnthropicProviderAllowed: boolean
) {
  const preferredProviderOrder = getPreferredProviderOrder(requestedModel);
  const ignoredProviders = getIgnoredProviders(requestedModel, isAnthropicProviderAllowed);
  if (preferredProviderOrder.length === 0 && ignoredProviders.length === 0) {
    return;
  }
  const provider = isOpenRouterProviderConfig(requestToMutate.provider)
    ? requestToMutate.provider
    : {};
  if (preferredProviderOrder.length > 0 && !provider.order) {
    console.debug(
      `[applyPreferredProvider] Preferentially routing ${requestedModel} to ${preferredProviderOrder.join()}`
    );
    provider.order = preferredProviderOrder;
  }
  requestToMutate.provider = withIgnoredProviders(provider, ignoredProviders);
}

/**
 * Fallback models are not supported: a request for a free model could fall
 * back to a paid model and be served without being charged. OpenRouter accepts
 * them as `models` on every API and as `fallbacks` on the Messages API.
 */
export function removeModelsFallback(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userId: string
) {
  const { models, fallbacks } = requestToMutate.body;
  delete requestToMutate.body.models;
  delete requestToMutate.body.fallbacks;

  if (!hasFallbackModels(models) && !hasFallbackModels(fallbacks)) {
    return;
  }
  console.warn('[applyProviderSpecificLogic] Removed caller-provided fallback models', {
    userId,
    model: requestedModel,
    requestKind: requestToMutate.kind,
    models,
    fallbacks,
  });
}

function hasFallbackModels(value: unknown) {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

function getServerToolType(tool: unknown): string | null {
  if (!isRecord(tool) || typeof tool.type !== 'string') {
    return null;
  }
  return tool.type === 'function' || tool.type === 'custom' ? null : tool.type;
}

// Plugins OpenRouter does not bill separately. Every other plugin id, including
// ids added later, is removed from free requests.
const FREE_PLUGIN_IDS: ReadonlySet<string> = new Set(['response-healing', 'context-compression']);

// Without a configured engine, OpenRouter parses PDFs with Mistral OCR, billed
// per page, for models that do not accept files natively.
const FREE_PDF_PARSER_PLUGIN = { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } };

function isFreePlugin(plugin: unknown) {
  return isRecord(plugin) && typeof plugin.id === 'string' && FREE_PLUGIN_IDS.has(plugin.id);
}

/**
 * OpenRouter bills plugins (web search, PDF parsing with OCR) and server tools
 * (`openrouter:*` and their aliases such as `web_search_20250305`) to the
 * gateway's account, even when the model itself is free. Free and anonymous
 * requests keep only free plugins and tools the client executes itself.
 */
export function removePaidServerFeatures(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userId: string
) {
  const body: { plugins?: unknown; tools?: unknown; tool_choice?: unknown } = requestToMutate.body;
  const { plugins, tools, tool_choice } = body;

  const requestedPlugins: unknown[] =
    plugins === undefined || plugins === null ? [] : Array.isArray(plugins) ? plugins : [plugins];
  const removedPlugins = requestedPlugins.filter(plugin => !isFreePlugin(plugin));
  const keptPlugins = [
    ...requestedPlugins.filter(isFreePlugin),
    ...(provider.id === 'openrouter' ? [FREE_PDF_PARSER_PLUGIN] : []),
  ];
  if (keptPlugins.length > 0) {
    body.plugins = keptPlugins;
  } else {
    delete body.plugins;
  }

  const removedToolTypes = Array.isArray(tools)
    ? tools.map(getServerToolType).filter(type => type !== null)
    : [];
  if (Array.isArray(tools) && removedToolTypes.length > 0) {
    const keptTools = tools.filter(tool => getServerToolType(tool) === null);
    if (keptTools.length > 0) {
      body.tools = keptTools;
    } else {
      delete body.tools;
    }
    const forcesRemovedTool =
      isRecord(tool_choice) &&
      typeof tool_choice.type === 'string' &&
      removedToolTypes.includes(tool_choice.type);
    if (keptTools.length === 0 || forcesRemovedTool) {
      delete body.tool_choice;
    }
  }

  if (removedPlugins.length === 0 && removedToolTypes.length === 0) {
    return;
  }
  console.warn('[applyProviderSpecificLogic] Removed paid server features from free request', {
    userId,
    model: requestedModel,
    requestKind: requestToMutate.kind,
    removedPlugins,
    removedToolTypes,
  });
}

export function removeUnsupportedRequestServiceTier(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel | null
) {
  const customPricing = getCustomPricing(requestedModel);
  const reason =
    customPricing && !customPricing.fallbackOnly
      ? 'non-fallback custom pricing'
      : kiloExclusiveModel && !kiloExclusiveModel.flags.includes('flex')
        ? 'non-Flex Kilo-exclusive model'
        : null;
  const serviceTier = requestToMutate.body.service_tier;
  if (!reason || serviceTier === undefined) {
    return;
  }

  console.warn('[applyProviderSpecificLogic] Removed unsupported request-level service tier', {
    model: requestedModel,
    requestKind: requestToMutate.kind,
    serviceTier,
    reason,
  });
  delete requestToMutate.body.service_tier;
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
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  switch (provider.responseTransforms) {
    case ReasoningDetailsTransform.GeminiThought:
      applyGeminiReasoningTransform(requestToMutate.body);
      break;
    case ReasoningDetailsTransform.ReasoningContent:
      mapReasoningDetailsToReasoningContent(requestToMutate.body);
      break;
    case null:
      break;
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
  taskId: string | null,
  isNonTrialEnterprise: boolean
) {
  removeModelsFallback(requestedModel, requestToMutate, userId);
  if (isFreeModelExcludingCustomLlms(requestedModel) || isAnonymousUserId(userId)) {
    removePaidServerFeatures(provider, requestedModel, requestToMutate, userId);
  }
  applyTrackingIds(requestToMutate, provider, userId, taskId);

  sanitizeBinaryToolResults(requestToMutate);

  if (isGeminiModel(requestedModel)) {
    sanitizeJsonRefToolResults(requestToMutate);
  }

  if (isMuseModel(requestedModel)) {
    // Meta rejects tools with "Recursive JSON schemas are not currently supported"
    removeRecursiveToolSchemaRefs(requestToMutate);
  }

  if (isClaudeModel(requestedModel)) {
    // Anthropic rejects tools with "input_schema does not support oneOf, allOf, or anyOf at the top level"
    removeTopLevelToolSchemaCombinators(requestToMutate);
  }

  if (requestToMutate.kind === 'chat_completions') {
    scrubOpenCodeSpecificProperties(requestToMutate.body);

    repairChatCompletionsTools(requestToMutate.body);

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
  removeUnsupportedRequestServiceTier(requestedModel, requestToMutate, kiloExclusiveModel);
  if (kiloExclusiveModel) {
    applyKiloExclusiveModelSettings(requestToMutate, kiloExclusiveModel);
  }

  if (isClaudeModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (provider.id === 'openrouter' || provider.id === 'vercel') {
    // A user's own BYOK credential is never ignored.
    applyPreferredProvider(
      requestedModel,
      requestToMutate.body,
      isNonTrialEnterprise || userByok !== null
    );
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

  if (isReflectionModel(requestedModel)) {
    addReflectionReasoningPlaceholders(requestedModel, requestToMutate);
  }

  if (provider.id === 'vercel') {
    await applyVercelSettings(requestedModel, requestToMutate, userByok);
  }

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

  applyReasoningDetailsTransform(provider, requestToMutate);
}
