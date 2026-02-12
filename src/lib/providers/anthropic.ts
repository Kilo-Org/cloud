import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/tool-calling';
import type OpenAI from 'openai';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.5';

export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

export const opus_46_free_slackbot_model = {
  public_id: 'anthropic/claude-opus-4.6:slackbot',
  display_name: 'Anthropic: Claude Opus 4.6 (Free for Kilo for Slack)',
  description: 'Free version of Claude Opus 4.6 for use in Kilo for Slack only',
  context_length: 1_000_000,
  max_completion_tokens: 32000,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'openrouter',
  internal_id: 'anthropic/claude-opus-4.6',
  inference_providers: ['amazon-bedrock'],
  slackbot_only: true,
} as KiloFreeModel;

const ENABLE_ANTHROPIC_STRICT_TOOL_USE = false;

const ENABLE_ANTHROPIC_AUTOMATIC_CACHING = true;

const ENABLE_ANTHROPIC_FINE_GRAINED_TOOL_STREAMING = true;

export function isAnthropicModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-haiku');
}

export function isOpusModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-opus');
}

type ReadFileParametersSchema = {
  properties?: {
    files?: {
      items?: {
        properties?: { line_ranges?: { items?: { minItems?: number; maxItems?: number } } };
      };
    };
  };
};

function patchReadFileTool(func: OpenAI.FunctionDefinition) {
  try {
    const lineRangesItems = (func.parameters as ReadFileParametersSchema | undefined)?.properties
      ?.files?.items?.properties?.line_ranges?.items;
    if (lineRangesItems) {
      delete lineRangesItems.minItems;
      delete lineRangesItems.maxItems;
    }
    func.strict = true;
    return true;
  } catch (e) {
    console.error('[patchReadFileTool]', e);
    return false;
  }
}

function appendAnthropicBetaHeader(extraHeaders: Record<string, string>, betaFlag: string) {
  extraHeaders['x-anthropic-beta'] = [extraHeaders['x-anthropic-beta'], betaFlag]
    .filter(Boolean)
    .join(',');
}

function applyAnthropicStrictToolUse(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  let supportedToolFound = false;
  for (const tool of requestToMutate.tools ?? []) {
    if (tool.type === 'function') {
      if (tool.function.name === 'read_file' && patchReadFileTool(tool.function)) {
        supportedToolFound = true;
      } else {
        delete tool.function.strict;
      }
    }
  }
  if (supportedToolFound) {
    console.debug('[applyAnthropicStrictToolUse] setting structured-outputs beta header');
    appendAnthropicBetaHeader(extraHeaders, 'structured-outputs-2025-11-13');
  }
}

function hasCacheControl(message: OpenAI.ChatCompletionMessageParam) {
  return (
    Array.isArray(message.content) && message.content.some(content => 'cache_control' in content)
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
    console.debug(
      "[addCacheBreakpoints] no system prompt, assuming this is a simple request that doesn't benefit from caching"
    );
    return;
  }

  if (hasCacheControl(systemPrompt)) {
    console.debug(
      '[addCacheBreakpoints] system prompt has cache breakpoint, assuming no work is necessary'
    );
    return;
  }

  console.debug('[addCacheBreakpoints] setting cache breakpoint on system prompt');
  setCacheControl(systemPrompt);

  const lastUserMessage = messages.findLast(msg => msg.role === 'user' || msg.role === 'tool');
  if (lastUserMessage) {
    console.debug(
      `[addCacheBreakpoints] setting cache breakpoint on last ${lastUserMessage.role} message`
    );
    setCacheControl(lastUserMessage);
  }

  const lastAssistantIndex = messages.findLastIndex(msg => msg.role === 'assistant');
  if (lastAssistantIndex >= 0) {
    const previousUserMessage = messages
      .slice(0, lastAssistantIndex)
      .findLast(msg => msg.role === 'user' || msg.role === 'tool');
    if (previousUserMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on second-to-last ${previousUserMessage.role} message`
      );
      setCacheControl(previousUserMessage);
    }
  }
}

export function applyAnthropicModelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (ENABLE_ANTHROPIC_STRICT_TOOL_USE) {
    applyAnthropicStrictToolUse(requestToMutate, extraHeaders);
  }

  if (ENABLE_ANTHROPIC_FINE_GRAINED_TOOL_STREAMING) {
    console.debug(
      '[applyAnthropicModelSettings] setting fine-grained-tool-streaming-2025-05-14 beta header'
    );
    appendAnthropicBetaHeader(extraHeaders, 'fine-grained-tool-streaming-2025-05-14');
  }

  if (ENABLE_ANTHROPIC_AUTOMATIC_CACHING) {
    // kilo/auto doesn't get cache breakpoints, because clients don't know it's a Claude model
    // additionally it is a common bug to forget adding cache breakpoints
    // we may want to gate this for Kilo-clients at some point
    addCacheBreakpoints(requestToMutate.messages);
  }

  if (isOpusModel(requestedModel) && !requestToMutate.verbosity) {
    requestToMutate.verbosity = 'medium';
  }

  // anthropic doesn't allow '.' in tool call ids
  normalizeToolCallIds(requestToMutate, toolCallId => toolCallId.includes('.'), undefined);
}
