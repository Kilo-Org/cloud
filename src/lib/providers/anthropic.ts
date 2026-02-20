import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/tool-calling';
import type OpenAI from 'openai';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';

export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

const ENABLE_ANTHROPIC_AUTOMATIC_CACHING = true;

export function isAnthropicModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-haiku');
}

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
  appendAnthropicBetaHeader(extraHeaders, 'fine-grained-tool-streaming-2025-05-14');

  if (ENABLE_ANTHROPIC_AUTOMATIC_CACHING) {
    // kilo/auto doesn't get cache breakpoints, because clients don't know it's a Claude model
    // additionally it is a common bug to forget adding cache breakpoints
    // we may want to gate this for Kilo-clients at some point
    addCacheBreakpoints(requestToMutate.messages);
  }

  // anthropic doesn't allow '.' in tool call ids
  normalizeToolCallIds(requestToMutate, toolCallId => toolCallId.includes('.'), undefined);
}
