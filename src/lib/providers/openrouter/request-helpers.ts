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

export function addCacheBreakpoints(request: GatewayRequest) {
  if (
    request.kind === 'chat_completions' &&
    Array.isArray(request.body.messages) &&
    request.body.messages.length > 1
  ) {
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
    request.body.input.length > 1
  ) {
    const lastMessage = request.body.input.findLast(
      msg => (msg.type === 'message' && msg.role === 'user') || msg.type === 'function_call_output'
    );
    if (lastMessage) {
      console.debug(
        `[addCacheBreakpoints] setting cache breakpoint on last ${lastMessage.type} responses message`
      );
      setCacheControlOnResponsesMessage(lastMessage);
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

export function requestContainsImages(request: GatewayRequest): boolean {
  switch (request.kind) {
    case 'chat_completions':
      return request.body.messages.some(
        msg =>
          (msg.role === 'user' || msg.role === 'tool') &&
          Array.isArray(msg.content) &&
          msg.content.some(part => part.type === 'image_url')
      );
    case 'responses': {
      if (!Array.isArray(request.body.input)) return false;
      return request.body.input.some(item => {
        if (typeof item === 'string') return false;
        if (item.type === 'message') {
          return (
            Array.isArray(item.content) && item.content.some(part => part.type === 'input_image')
          );
        }
        if (item.type === 'function_call_output') {
          return (
            Array.isArray(item.output) && item.output.some(part => part.type === 'input_image')
          );
        }
        return false;
      });
    }
    case 'messages':
      return request.body.messages.some(
        msg =>
          Array.isArray(msg.content) &&
          msg.content.some(
            block =>
              block.type === 'image' ||
              (block.type === 'tool_result' &&
                Array.isArray(block.content) &&
                block.content.some(inner => inner.type === 'image'))
          )
      );
  }
}
