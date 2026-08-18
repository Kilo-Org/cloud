import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { ReasoningDetailType } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
  MessageWithReasoning,
  OpenCodeSpecificProperties,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

export function getMaxTokens(request: GatewayRequest) {
  if (request.kind === 'responses') {
    return request.body.max_output_tokens ?? null;
  }
  if (request.kind === 'messages') {
    return request.body.max_tokens ?? null;
  }
  return request.body.max_completion_tokens ?? request.body.max_tokens ?? null;
}

export function hasMiddleOutTransform(request: GatewayRequest) {
  return (
    (request.kind === 'chat_completions' && request.body.transforms?.includes('middle-out')) ||
    false
  );
}

function findEnvironmentDetailsCacheTargetIndex(
  content: ReadonlyArray<{ type: string; text?: string }>
) {
  const environmentDetailsIndex = content.findIndex(
    (item, index) =>
      index > 0 &&
      (item.type === 'text' || item.type === 'input_text') &&
      item.text?.startsWith('<environment_details>')
  );
  return environmentDetailsIndex > 0 ? environmentDetailsIndex - 1 : undefined;
}

function setCacheControlOnChatCompletionsMessage(message: OpenAI.ChatCompletionMessageParam) {
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
    const cacheTargetIndex =
      message.role === 'user' ? findEnvironmentDetailsCacheTargetIndex(message.content) : undefined;
    const cacheTarget =
      cacheTargetIndex === undefined ? message.content.at(-1) : message.content[cacheTargetIndex];
    if (cacheTarget) {
      // @ts-expect-error non-standard extension
      cacheTarget.cache_control = { type: 'ephemeral' };
    }
  }
}

const RESPONSES_PROMPT_CACHE_BREAKPOINT: OpenAI.Responses.ResponseInputText.PromptCacheBreakpoint =
  {
    mode: 'explicit',
  };

function isResponsesInputMessage(
  message: OpenAI.Responses.ResponseInputItem
): message is OpenAI.Responses.EasyInputMessage | OpenAI.Responses.ResponseInputItem.Message {
  return (
    message.type === 'message' &&
    (message.role === 'user' || message.role === 'system' || message.role === 'developer')
  );
}

function setPromptCacheBreakpointOnResponsesMessage(message: OpenAI.Responses.ResponseInputItem) {
  if (isResponsesInputMessage(message)) {
    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'input_text',
          text: message.content,
          prompt_cache_breakpoint: RESPONSES_PROMPT_CACHE_BREAKPOINT,
        },
      ];
    } else if (Array.isArray(message.content)) {
      const cacheTargetIndex =
        message.role === 'user'
          ? findEnvironmentDetailsCacheTargetIndex(message.content)
          : undefined;
      const cacheTarget =
        cacheTargetIndex === undefined ? message.content.at(-1) : message.content[cacheTargetIndex];
      if (cacheTarget) {
        cacheTarget.prompt_cache_breakpoint = RESPONSES_PROMPT_CACHE_BREAKPOINT;
      }
    }
  } else if (message.type === 'function_call_output') {
    if (typeof message.output === 'string') {
      message.output = [
        {
          type: 'input_text',
          text: message.output,
          prompt_cache_breakpoint: RESPONSES_PROMPT_CACHE_BREAKPOINT,
        },
      ];
    } else if (Array.isArray(message.output)) {
      const lastItem = message.output.at(-1);
      if (lastItem) {
        lastItem.prompt_cache_breakpoint = RESPONSES_PROMPT_CACHE_BREAKPOINT;
      }
    }
  }
}

function setCacheControlOnMessagesMessage(
  message: Anthropic.MessageParam,
  cacheControl: Anthropic.CacheControlEphemeral
) {
  if (typeof message.content === 'string') {
    message.content = [
      {
        type: 'text',
        text: message.content,
        cache_control: cacheControl,
      },
    ];
  } else {
    const environmentDetailsCacheTargetIndex =
      message.role === 'user' ? findEnvironmentDetailsCacheTargetIndex(message.content) : undefined;
    const environmentDetailsCacheTarget =
      environmentDetailsCacheTargetIndex === undefined
        ? undefined
        : message.content[environmentDetailsCacheTargetIndex];
    const cacheTarget =
      environmentDetailsCacheTarget &&
      isCacheableMessagesContentBlock(environmentDetailsCacheTarget)
        ? environmentDetailsCacheTarget
        : message.content.findLast(isCacheableMessagesContentBlock);
    if (cacheTarget) {
      cacheTarget.cache_control = cacheControl;
    }
  }
}

function setCacheControlOnMessagesSystem(
  system: NonNullable<Anthropic.MessageCreateParams['system']>,
  cacheControl: Anthropic.CacheControlEphemeral
): NonNullable<Anthropic.MessageCreateParams['system']> {
  if (typeof system === 'string') {
    return [{ type: 'text', text: system, cache_control: cacheControl }];
  }
  const cacheTarget = system.at(-1);
  if (cacheTarget) {
    cacheTarget.cache_control = cacheControl;
  }
  return system;
}

function isCacheableMessagesContentBlock(
  item: Anthropic.ContentBlockParam
): item is Exclude<
  Anthropic.ContentBlockParam,
  Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam
> {
  return item.type !== 'thinking' && item.type !== 'redacted_thinking';
}

function hasCacheableMessagesContent(message: Anthropic.MessageParam) {
  return typeof message.content === 'string'
    ? message.content.length > 0
    : message.content.some(isCacheableMessagesContentBlock);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function containsCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCacheControl);
  }
  if (!isObjectRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, 'cache_control') || Object.hasOwn(value, 'prompt_cache_breakpoint')) {
    return true;
  }
  return Object.values(value).some(containsCacheControl);
}

export function addCacheBreakpoints(request: GatewayRequest) {
  if (
    request.kind === 'chat_completions' &&
    Array.isArray(request.body.messages) &&
    !containsCacheControl(request.body.messages)
  ) {
    const systemMessage = request.body.messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      console.debug(
        '[addCacheBreakpoints] setting cache breakpoint on system chat completions message'
      );
      setCacheControlOnChatCompletionsMessage(systemMessage);
    }
    const lastMessage = request.body.messages.findLast(
      msg => msg.role === 'user' || msg.role === 'tool'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.role} chat completions message`
      );
      setCacheControlOnChatCompletionsMessage(lastMessage);
    }
  } else if (
    request.kind === 'responses' &&
    Array.isArray(request.body.input) &&
    !containsCacheControl(request.body.input)
  ) {
    const instructionsMessage = request.body.input.findLast(
      msg => msg.type === 'message' && (msg.role === 'system' || msg.role === 'developer')
    );
    if (instructionsMessage) {
      console.debug(
        '[addCacheBreakpoints] setting cache breakpoint on instructions responses message'
      );
      setPromptCacheBreakpointOnResponsesMessage(instructionsMessage);
    }
    const lastMessage = request.body.input.findLast(
      msg => (msg.type === 'message' && msg.role === 'user') || msg.type === 'function_call_output'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.type} responses message`
      );
      setPromptCacheBreakpointOnResponsesMessage(lastMessage);
    }
  } else if (
    request.kind === 'messages' &&
    !containsCacheControl(request.body.system) &&
    !containsCacheControl(request.body.messages)
  ) {
    // Vercel AI Gateway does not honor top-level cache_control on Messages API requests.
    const cacheControl = request.body.cache_control ?? { type: 'ephemeral' };
    delete request.body.cache_control;
    if (request.body.system) {
      console.debug('[addCacheBreakpoints] setting cache breakpoint on messages system prompt');
      request.body.system = setCacheControlOnMessagesSystem(request.body.system, cacheControl);
    }
    const lastMessage = request.body.messages.findLast(hasCacheableMessagesContent);
    if (lastMessage) {
      console.debug('[addCacheBreakpoints] setting cache breakpoint on last messages message');
      setCacheControlOnMessagesMessage(lastMessage, cacheControl);
    }
  }
}

export function fixResponsesRequest(request: GatewayResponsesRequest) {
  if (!Array.isArray(request.input)) {
    return;
  }
  for (const msg of request.input) {
    const outputMsg = msg as Partial<OpenAI.Responses.ResponseOutputMessage>;
    if (outputMsg.role !== 'assistant') {
      continue;
    }
    if (!outputMsg.type) {
      outputMsg.type = 'message';
    }
    if (!outputMsg.status) {
      outputMsg.status = 'completed';
    }
  }
}

export function removeChatCompletionsReasoning(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if ('reasoning' in message) {
      delete message.reasoning;
    }
    if ('reasoning_content' in message) {
      delete message.reasoning_content;
    }
    if ('reasoning_details' in message) {
      delete message.reasoning_details;
    }
  }
}

export function removeChatCompletionsToolNames(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if (message.role === 'tool' && 'name' in message) {
      delete message.name;
    }
  }
}

/**
 * Inverse of the `mapReasoningContentToDetails` response transform: folds
 * OpenRouter-style `reasoning_details` back into the DeepSeek-style
 * `reasoning_content` string that upstreams like Friendli and Perplexity
 * expect on chat completions messages.
 */
export function mapReasoningDetailsToReasoningContent(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    const messageWithReasoning = message as typeof message & MessageWithReasoning;
    const reasoningDetails = messageWithReasoning.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      continue;
    }
    delete messageWithReasoning.reasoning_details;

    const reasoningContent = reasoningDetails
      .map(detail => {
        switch (detail.type) {
          case ReasoningDetailType.Text:
            return detail.text ?? '';
          case ReasoningDetailType.Summary:
            return detail.summary;
          case ReasoningDetailType.Encrypted:
            // Opaque provider-specific blob; not representable as reasoning_content.
            return '';
        }
      })
      .join('');

    if (reasoningContent) {
      messageWithReasoning.reasoning_content = reasoningContent;
    }
  }
}

export function scrubOpenCodeSpecificProperties(request: OpenRouterChatCompletionRequest) {
  const body = request as OpenCodeSpecificProperties;
  delete body.description;
  delete body.usage;
  delete body.reasoningEffort;
}

export function isReasoningExplicitlyDisabled(request: GatewayRequest) {
  if (request.kind === 'messages') {
    return request.body.thinking?.type === 'disabled';
  }
  if (request.kind === 'responses') {
    return request.body.reasoning?.effort === 'none';
  }
  if (request.body.reasoning?.enabled === true) {
    return false;
  }
  return (
    (request.body.reasoning?.effort ?? request.body.reasoning_effort) === 'none' ||
    request.body.enable_thinking === false || // Alibaba
    request.body.thinking?.type === 'disabled' // Bytedance
  );
}

export function isReasoningExplicitlyEnabled(request: GatewayRequest) {
  if (request.kind === 'messages') {
    return request.body.thinking?.type === 'enabled' || request.body.thinking?.type === 'adaptive';
  }
  if (request.kind === 'responses') {
    return request.body.reasoning?.effort !== undefined && request.body.reasoning.effort !== 'none';
  }
  if (request.body.reasoning?.enabled === false) {
    return false;
  }
  return (
    request.body.reasoning?.enabled === true ||
    (request.body.reasoning?.effort !== undefined && request.body.reasoning.effort !== 'none') ||
    (request.body.reasoning_effort !== undefined && request.body.reasoning_effort !== 'none') ||
    request.body.enable_thinking === true || // Alibaba
    request.body.thinking?.type === 'enabled' // Bytedance
  );
}

export function enableReasoningSummaries(request: GatewayRequest) {
  if (
    request.kind === 'messages' &&
    request.body.thinking &&
    (request.body.thinking.type === 'enabled' || request.body.thinking.type === 'adaptive') &&
    !request.body.thinking.display
  ) {
    request.body.thinking.display = 'summarized';
  }
  if (request.kind === 'responses' && request.body.reasoning && !request.body.reasoning.summary) {
    request.body.reasoning.summary = 'auto';
  }
}
