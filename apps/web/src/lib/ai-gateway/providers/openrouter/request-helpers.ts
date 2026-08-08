import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
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
    const lastItem = message.content.at(-1);
    if (lastItem) {
      // @ts-expect-error non-standard extension
      lastItem.cache_control = { type: 'ephemeral' };
    }
  }
}

function setCacheBreakpointOnResponsesMessage(message: OpenAI.Responses.ResponseInputItem) {
  if (message.type === 'message') {
    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'input_text',
          text: message.content,
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ];
    } else if (Array.isArray(message.content)) {
      const lastItem = message.content.at(-1);
      if (lastItem && lastItem.type === 'input_text') {
        lastItem.prompt_cache_breakpoint = { mode: 'explicit' };
      }
    }
  } else if (message.type === 'function_call_output') {
    if (typeof message.output === 'string') {
      message.output = [
        {
          type: 'input_text',
          text: message.output,
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ];
    } else if (Array.isArray(message.output)) {
      const lastItem = message.output.at(-1);
      if (
        lastItem &&
        typeof lastItem === 'object' &&
        'type' in lastItem &&
        lastItem.type === 'input_text'
      ) {
        (lastItem as OpenAI.Responses.ResponseInputText).prompt_cache_breakpoint = {
          mode: 'explicit',
        };
      }
    }
  }
}

function isEnvironmentDetailsChatCompletionsPart(part: OpenAI.ChatCompletionContentPart): boolean {
  return (
    part.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.startsWith('<environment_details>')
  );
}

function isEnvironmentDetailsResponsesPart(part: OpenAI.Responses.ResponseInputContent): boolean {
  return (
    (part.type === 'input_text' || (part as { type?: string }).type === 'text') &&
    typeof (part as { text?: string }).text === 'string' &&
    (part as { text: string }).text.startsWith('<environment_details>')
  );
}

function isEnvironmentDetailsMessagesPart(part: Anthropic.ContentBlockParam): boolean {
  return (
    part.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.startsWith('<environment_details>')
  );
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
    const lastItem = message.content.findLast(isCacheableMessagesContentBlock);
    if (lastItem) {
      lastItem.cache_control = cacheControl;
    }
  }
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
  if (
    Object.hasOwn(value, 'cache_control') ||
    Object.hasOwn(value, 'prompt_cache_breakpoint') ||
    Object.hasOwn(value, 'prompt_cache_options')
  ) {
    return true;
  }
  return Object.values(value).some(containsCacheControl);
}

function deleteCacheControl(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      deleteCacheControl(item);
    }
    return;
  }
  if (!isObjectRecord(value)) {
    return;
  }
  if (Object.hasOwn(value, 'cache_control')) {
    delete value.cache_control;
  }
  if (Object.hasOwn(value, 'prompt_cache_breakpoint')) {
    delete value.prompt_cache_breakpoint;
  }
  if (Object.hasOwn(value, 'prompt_cache_options')) {
    delete value.prompt_cache_options;
  }
  for (const item of Object.values(value)) {
    deleteCacheControl(item);
  }
}

export function addCacheBreakpoints(request: GatewayRequest) {
  if (
    request.kind === 'chat_completions' &&
    Array.isArray(request.body.messages) &&
    request.body.messages.length > 1 &&
    !containsCacheControl(request.body.messages) &&
    !containsCacheControl((request.body as Record<string, unknown>).prompt_cache_options)
  ) {
    const systemMessage = request.body.messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      console.debug(
        '[addCacheBreakpoints] setting cache breakpoint on system chat completions message'
      );
      setCacheControlOnChatCompletionsMessage(systemMessage);
    }

    const lastUserMessageWithEnvDetails = request.body.messages.findLast(
      (msg): msg is OpenAI.ChatCompletionUserMessageParam =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some(isEnvironmentDetailsChatCompletionsPart)
    );
    if (lastUserMessageWithEnvDetails && Array.isArray(lastUserMessageWithEnvDetails.content)) {
      const envIndex = lastUserMessageWithEnvDetails.content.findIndex(
        isEnvironmentDetailsChatCompletionsPart
      );
      if (envIndex > 0) {
        const targetElement = lastUserMessageWithEnvDetails.content[envIndex - 1];
        if (targetElement) {
          console.debug(
            '[addCacheBreakpoints] setting cache breakpoint before environment details in chat completions'
          );
          // @ts-expect-error non-standard extension
          targetElement.cache_control = { type: 'ephemeral' };
        }
      }
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
    request.body.input.length > 1 &&
    !containsCacheControl(request.body.input) &&
    !containsCacheControl((request.body as Record<string, unknown>).prompt_cache_options)
  ) {
    request.body.prompt_cache_options = {
      ...(request.body as { prompt_cache_options?: Record<string, unknown> }).prompt_cache_options,
      mode: 'implicit',
    };

    const systemMessage = request.body.input.find(
      msg => msg.type === 'message' && msg.role === 'system'
    );
    if (systemMessage) {
      console.debug('[addCacheBreakpoints] setting cache breakpoint on system responses message');
      setCacheBreakpointOnResponsesMessage(systemMessage);
    }

    const lastUserMessageWithEnvDetails = request.body.input.findLast(
      (item): item is Extract<OpenAI.Responses.ResponseInputItem, { type: 'message' }> =>
        item.type === 'message' &&
        item.role === 'user' &&
        Array.isArray(item.content) &&
        item.content.some(isEnvironmentDetailsResponsesPart)
    );
    if (lastUserMessageWithEnvDetails && Array.isArray(lastUserMessageWithEnvDetails.content)) {
      const envIndex = lastUserMessageWithEnvDetails.content.findIndex(
        isEnvironmentDetailsResponsesPart
      );
      if (envIndex > 0) {
        const targetElement = lastUserMessageWithEnvDetails.content[envIndex - 1];
        if (targetElement && targetElement.type === 'input_text') {
          console.debug(
            '[addCacheBreakpoints] setting cache breakpoint before environment details in responses'
          );
          targetElement.prompt_cache_breakpoint = { mode: 'explicit' };
        }
      }
    }

    const lastMessage = request.body.input.findLast(
      msg => (msg.type === 'message' && msg.role === 'user') || msg.type === 'function_call_output'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.type} responses message`
      );
      setCacheBreakpointOnResponsesMessage(lastMessage);
    }
  } else if (
    request.kind === 'messages' &&
    request.body.messages.length > 1 &&
    !containsCacheControl(request.body.messages)
  ) {
    const cacheControl = request.body.cache_control ?? { type: 'ephemeral' };
    delete request.body.cache_control;

    const lastUserMessageWithEnvDetails = request.body.messages.findLast(
      msg =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some(isEnvironmentDetailsMessagesPart)
    );
    if (lastUserMessageWithEnvDetails && Array.isArray(lastUserMessageWithEnvDetails.content)) {
      const envIndex = lastUserMessageWithEnvDetails.content.findIndex(
        isEnvironmentDetailsMessagesPart
      );
      if (envIndex > 0) {
        const targetElement = lastUserMessageWithEnvDetails.content[envIndex - 1];
        if (targetElement && isCacheableMessagesContentBlock(targetElement)) {
          console.debug(
            '[addCacheBreakpoints] setting cache breakpoint before environment details in messages'
          );
          targetElement.cache_control = cacheControl;
        }
      }
    }

    const lastMessage = request.body.messages.findLast(hasCacheableMessagesContent);
    if (lastMessage) {
      console.debug('[addCacheBreakpoints] setting cache breakpoint on last messages message');
      // Vercel AI Gateway does not honor top-level cache_control on Messages API requests.
      setCacheControlOnMessagesMessage(lastMessage, cacheControl);
    }
  }
}

export function removeCacheBreakpoints(request: GatewayRequest) {
  if (request.kind === 'chat_completions' && Array.isArray(request.body.messages)) {
    console.debug('[removeCacheBreakpoints] removing cache breakpoints from chat completions');
    deleteCacheControl(request.body.messages);
    delete (request.body as Record<string, unknown>).prompt_cache_options;
  } else if (request.kind === 'responses' && Array.isArray(request.body.input)) {
    console.debug('[removeCacheBreakpoints] removing cache breakpoints from responses request');
    deleteCacheControl(request.body.input);
    delete (request.body as Record<string, unknown>).prompt_cache_options;
  } else if (request.kind === 'messages') {
    console.debug('[removeCacheBreakpoints] removing cache breakpoints from messages request');
    delete request.body.cache_control;
    deleteCacheControl(request.body.messages);
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

export function injectReasoningIntoContent(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') {
    return;
  }
  for (const message of request.body.messages) {
    if (message.role !== 'assistant') {
      continue;
    }

    const reasoning =
      'reasoning' in message && typeof message.reasoning === 'string'
        ? message.reasoning
        : 'reasoning_content' in message && typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : '';

    if (reasoning) {
      if (Array.isArray(message.content)) {
        message.content.splice(0, 0, { type: 'text', text: `<think>${reasoning}</think>` });
      } else {
        message.content = `<think>${reasoning}</think>${message.content}`;
      }
      if ('reasoning' in message) delete message.reasoning;
      if ('reasoning_content' in message) delete message.reasoning_content;
      if ('reasoning_details' in message) delete message.reasoning_details;
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
