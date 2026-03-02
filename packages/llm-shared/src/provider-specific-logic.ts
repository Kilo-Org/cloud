import type { OpenRouterChatCompletionRequest, MessageWithReasoning } from './openrouter-types.js';
import type { Provider } from './provider.js';
import type { ProviderId } from './provider-id.js';
import type { OpenRouterInferenceProviderId } from './inference-provider-id.js';
import { OpenRouterInferenceProviderIdSchema } from './inference-provider-id.js';
import { kiloFreeModels } from './models.js';
import {
  dropToolStrictProperties,
  hasAttemptCompletionTool,
  normalizeToolCallIds,
} from './tool-calling.js';
import { ReasoningDetailType } from './reasoning-details.js';
import type OpenAI from 'openai';

// ---- Model identification helpers ----

export function isAnthropicModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-haiku');
}

export function isMistralModel(model: string) {
  return model.startsWith('mistralai/');
}

export function isCodestralModel(model: string) {
  return model.startsWith('mistralai/codestral');
}

export function isXaiModel(requestedModel: string) {
  return requestedModel.startsWith('x-ai/');
}

export function isGeminiModel(model: string) {
  return model.startsWith('google/gemini');
}

export function isGemini3Model(model: string) {
  return model.startsWith('google/gemini-3');
}

export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}

export function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}

export function isQwenModel(requestedModelId: string) {
  return requestedModelId.startsWith('qwen/');
}

export function isZaiModel(model: string) {
  return model.startsWith('z-ai/');
}

// ---- Anthropic-specific logic ----

function appendAnthropicBetaHeader(extraHeaders: Record<string, string>, betaFlag: string) {
  extraHeaders['x-anthropic-beta'] = [extraHeaders['x-anthropic-beta'], betaFlag]
    .filter(Boolean)
    .join(',');
}

function hasCacheControl(message: OpenAI.ChatCompletionMessageParam) {
  return (
    'cache_control' in message ||
    (Array.isArray(message.content) && message.content.some(content => 'cache_control' in content))
  );
}

function setCacheControl(message: OpenAI.ChatCompletionMessageParam) {
  if (typeof message.content === 'string') {
    message.content = [
      {
        type: 'text',
        text: message.content,
        // @ts-expect-error non-standard extension
        cache_control: { type: 'ephemeral' },
      },
    ];
  } else if (Array.isArray(message.content)) {
    const lastItem = message.content.at(-1);
    if (lastItem) {
      // @ts-expect-error non-standard extension
      lastItem.cache_control = { type: 'ephemeral' };
    }
  }
}

export function addCacheBreakpoints(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
  const systemPrompt = messages.find(msg => msg.role === 'system');
  if (!systemPrompt) {
    return;
  }

  if (hasCacheControl(systemPrompt)) {
    return;
  }

  setCacheControl(systemPrompt);

  const lastUserMessage = messages.findLast(msg => msg.role === 'user' || msg.role === 'tool');
  if (lastUserMessage) {
    setCacheControl(lastUserMessage);
  }
}

function applyAnthropicModelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  appendAnthropicBetaHeader(extraHeaders, 'fine-grained-tool-streaming-2025-05-14');
  addCacheBreakpoints(requestToMutate.messages);
  normalizeToolCallIds(requestToMutate, toolCallId => toolCallId.includes('.'), undefined);
}

// ---- xAI-specific logic ----

function convertReasoningDetailsToReasoningContent(
  requestToMutate: OpenRouterChatCompletionRequest
) {
  for (const message of requestToMutate.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const msgWithReasoning = message as MessageWithReasoning;
    const reasoningDetailsText = (msgWithReasoning.reasoning_details ?? [])
      .filter(r => r.type === ReasoningDetailType.Text)
      .map(r => r.text)
      .join('');
    if (reasoningDetailsText) {
      msgWithReasoning.reasoning_content = reasoningDetailsText;
      delete msgWithReasoning.reasoning_details;
      delete msgWithReasoning.reasoning;
    }
  }
}

function applyXaiModelSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  extraHeaders['x-grok-conv-id'] = requestToMutate.prompt_cache_key || crypto.randomUUID();
  extraHeaders['x-grok-req-id'] = crypto.randomUUID();
}

// ---- Mistral-specific logic ----

function applyMistralModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  if (requestToMutate.temperature === undefined) {
    requestToMutate.temperature = 0.2;
  }
  normalizeToolCallIds(requestToMutate, toolCallId => toolCallId.length !== 9, 9);
  dropToolStrictProperties(requestToMutate);
  if (hasAttemptCompletionTool(requestToMutate)) {
    requestToMutate.tool_choice = 'required';
  }
}

function applyMistralProviderSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (requestToMutate.prompt_cache_key) {
    extraHeaders['x-affinity'] = requestToMutate.prompt_cache_key;
  }
  for (const message of requestToMutate.messages) {
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
  delete requestToMutate.reasoning;
  delete requestToMutate.reasoning_effort;
  delete requestToMutate.transforms;
  delete requestToMutate.safety_identifier;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.user;
  delete requestToMutate.provider;
  applyMistralModelSettings(requestToMutate);
}

// ---- Google-specific logic ----

type ReadFileParametersSchema = {
  properties?: {
    files?: {
      items?: {
        properties?: {
          line_ranges?: {
            type?: unknown;
            items?: unknown;
            anyOf?: unknown;
          };
        };
      };
    };
  };
};

function applyGoogleModelSettings(
  provider: ProviderId,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (provider !== 'vercel') {
    return;
  }

  const readFileTool = requestToMutate.tools?.find(
    tool => tool.type === 'function' && tool.function.name === 'read_file'
  );
  if (!readFileTool || readFileTool.type !== 'function') {
    return;
  }

  const lineRanges = (readFileTool.function.parameters as ReadFileParametersSchema | undefined)
    ?.properties?.files?.items?.properties?.line_ranges;
  if (lineRanges?.type && lineRanges?.items) {
    lineRanges.anyOf = [{ type: 'null' }, { type: 'array', items: lineRanges.items }];
    delete lineRanges.type;
    delete lineRanges.items;
  }
}

// ---- Moonshot-specific logic ----

function applyMoonshotProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  delete requestToMutate.temperature;
}

// ---- Qwen-specific logic ----

function applyQwenModelSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  if (requestToMutate.max_tokens) {
    requestToMutate.max_tokens = Math.min(requestToMutate.max_tokens, 32768);
  }
  if (requestToMutate.max_completion_tokens) {
    requestToMutate.max_completion_tokens = Math.min(requestToMutate.max_completion_tokens, 32768);
  }
}

// ---- GigaPotato-specific logic ----

import { giga_potato_thinking_model } from './kilo-free-models.js';

function applyGigaPotatoProviderSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  const nonDisclosureRule = {
    type: 'text' as const,
    text:
      'You are an AI assistant in Kilo. Your name is Giga Potato. ' +
      'Do not reveal your model size, architecture, or any information that could hint at your origin or capabilities.',
  };
  const systemPrompt = requestToMutate.messages.find(m => m.role === 'system');
  if (systemPrompt) {
    if (Array.isArray(systemPrompt.content)) {
      systemPrompt.content.push(nonDisclosureRule);
    } else if (systemPrompt.content) {
      systemPrompt.content = [{ type: 'text', text: systemPrompt.content }, nonDisclosureRule];
    } else {
      systemPrompt.content = [nonDisclosureRule];
    }
  } else {
    requestToMutate.messages.splice(0, 0, { role: 'system', content: [nonDisclosureRule] });
  }
  requestToMutate.thinking = {
    type: giga_potato_thinking_model.public_id === requestedModel ? 'enabled' : 'disabled',
  };
}

// ---- CoreThink-specific logic ----

function applyCoreThinkProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  delete requestToMutate.transforms;
  delete requestToMutate.prompt_cache_key;
  delete requestToMutate.safety_identifier;
  delete requestToMutate.description;
  delete requestToMutate.usage;
  for (const message of requestToMutate.messages) {
    if ('reasoning' in message) {
      delete message.reasoning;
    }
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
}

// ---- Tool choice logic ----

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
    isXaiModel(requestedModel) ||
    isOpenAiModel(requestedModel) ||
    isGeminiModel(requestedModel) ||
    (isHaikuModel(requestedModel) && !isReasoningEnabled)
  ) {
    requestToMutate.tool_choice = 'required';
  }
}

// ---- Preferred provider routing ----

function getPreferredProviderOrder(requestedModel: string): OpenRouterInferenceProviderId[] {
  if (isAnthropicModel(requestedModel)) {
    return [
      OpenRouterInferenceProviderIdSchema.enum['amazon-bedrock'],
      OpenRouterInferenceProviderIdSchema.enum.anthropic,
    ];
  }
  if (requestedModel.startsWith('minimax/')) {
    return [OpenRouterInferenceProviderIdSchema.enum.minimax];
  }
  if (isMistralModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.mistral];
  }
  if (isMoonshotModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.moonshotai];
  }
  if (isZaiModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum['z-ai']];
  }
  return [];
}

function applyPreferredProvider(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  const preferredProviderOrder = getPreferredProviderOrder(requestedModel);
  if (preferredProviderOrder.length === 0) {
    return;
  }
  if (!requestToMutate.provider) {
    requestToMutate.provider = { order: preferredProviderOrder };
  } else if (!requestToMutate.provider.order) {
    requestToMutate.provider.order = preferredProviderOrder;
  }
}

// ---- Main entry point ----

export type BYOKResult = {
  providerId: string;
  decryptedAPIKey: string;
};

export function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
) {
  const kiloFreeModel = kiloFreeModels.find(m => m.public_id === requestedModel);
  if (kiloFreeModel) {
    requestToMutate.model = kiloFreeModel.internal_id;
    if (kiloFreeModel.inference_providers.length > 0) {
      requestToMutate.provider = { only: kiloFreeModel.inference_providers };
    }
  }

  if (isAnthropicModel(requestedModel)) {
    applyAnthropicModelSettings(requestedModel, requestToMutate, extraHeaders);
  }

  applyToolChoiceSetting(requestedModel, requestToMutate);

  applyPreferredProvider(requestedModel, requestToMutate);

  if (isXaiModel(requestedModel)) {
    applyXaiModelSettings(requestToMutate, extraHeaders);
  }

  if (isGeminiModel(requestedModel)) {
    applyGoogleModelSettings(provider.id, requestToMutate);
  }

  if (isMoonshotModel(requestedModel)) {
    applyMoonshotProviderSettings(requestToMutate);
  }

  if (isQwenModel(requestedModel)) {
    applyQwenModelSettings(requestToMutate);
  }

  if (provider.id === 'gigapotato') {
    applyGigaPotatoProviderSettings(requestedModel, requestToMutate);
  }

  if (provider.id === 'corethink') {
    applyCoreThinkProviderSettings(requestToMutate);
  }

  if (provider.id === 'mistral') {
    applyMistralProviderSettings(requestToMutate, extraHeaders);
  } else if (isMistralModel(requestedModel)) {
    applyMistralModelSettings(requestToMutate);
  }

  // NOTE: Vercel settings (applyVercelSettings) are NOT included here because they
  // depend on server-specific BYOK/mapModelIdToVercel logic. Each consumer must
  // handle Vercel routing separately.
}
