import type {
  GatewayRequest,
  GatewayResponsesRequest,
  OpenCodeSpecificProperties,
  OpenRouterChatCompletionRequest,
} from '@/lib/providers/openrouter/types';
import type OpenAI from 'openai';

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

function setCacheControlOnResponsesMessage(message: OpenAI.Responses.ResponseInputItem) {
  if (message.type === 'message') {
    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'input_text',
          text: message.content,
          // @ts-expect-error non-standard extension
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      const lastItem = message.content.at(-1);
      if (lastItem) {
        // @ts-expect-error non-standard extension
        lastItem.cache_control = { type: 'ephemeral' };
      }
    }
  } else if (message.type === 'function_call_output') {
    if (typeof message.output === 'string') {
      message.output = [
        {
          type: 'input_text',
          text: message.output,
          // @ts-expect-error non-standard extension
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      const lastItem = message.output.at(-1);
      if (lastItem) {
        // @ts-expect-error non-standard extension
        lastItem.cache_control = { type: 'ephemeral' };
      }
    }
  }
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
  if (Object.hasOwn(value, 'cache_control')) {
    return true;
  }
  return Object.values(value).some(containsCacheControl);
}

export function addCacheBreakpoints(request: GatewayRequest) {
  if (
    request.kind === 'chat_completions' &&
    Array.isArray(request.body.messages) &&
    request.body.messages.length > 1 &&
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
    request.body.input.length > 1 &&
    !containsCacheControl(request.body.input)
  ) {
    const systemMessage = request.body.input.find(
      msg => msg.type === 'message' && msg.role === 'system'
    );
    if (systemMessage) {
      console.debug('[addCacheBreakpoints] setting cache breakpoint on system responses message');
      setCacheControlOnResponsesMessage(systemMessage);
    }
    const lastMessage = request.body.input.findLast(
      msg => (msg.type === 'message' && msg.role === 'user') || msg.type === 'function_call_output'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.type} responses message`
      );
      setCacheControlOnResponsesMessage(lastMessage);
    }
  } else if (
    request.kind === 'messages' &&
    request.body.messages.length > 1 &&
    !request.body.cache_control &&
    !containsCacheControl(request.body.messages)
  ) {
    console.debug('[addCacheBreakpoints] setting cache breakpoint on messages request');
    request.body.cache_control = { type: 'ephemeral' };
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
      console.warn('[fixResponsesRequest] assistant message missing type, fixing');
      outputMsg.type = 'message';
    }
    if (!outputMsg.status) {
      console.warn('[fixResponsesRequest] assistant message missing status, fixing');
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
  return (request.body.reasoning?.effort ?? request.body.reasoning_effort) === 'none';
}
