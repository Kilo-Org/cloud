import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { ReasoningDetailType } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * Plain-text placeholders such as "[reasoning unavailable]" are copied
 * verbatim by Beam as its own reasoning, and whitespace makes it return empty
 * answers. Beam does not imitate an HTML comment, and the Cloud Agent UI
 * already hides comment-only reasoning.
 */
export const REASONING_PLACEHOLDER = '<!-- reasoning unavailable -->';

export function isReflectionModel(model: string) {
  return model.startsWith('reflection/');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasChatCompletionsReasoning(message: MessageWithReasoning) {
  return (
    isNonEmptyString(message.reasoning) ||
    isNonEmptyString(message.reasoning_content) ||
    (message.reasoning_details ?? []).some(detail => {
      switch (detail.type) {
        case ReasoningDetailType.Text:
          return isNonEmptyString(detail.text);
        case ReasoningDetailType.Summary:
          return isNonEmptyString(detail.summary);
        case ReasoningDetailType.Encrypted:
          return false;
      }
    })
  );
}

function addChatCompletionsReasoningPlaceholders(request: OpenRouterChatCompletionRequest) {
  let placeholderCount = 0;
  for (const message of request.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const assistant = message as typeof message & MessageWithReasoning;
    if (hasChatCompletionsReasoning(assistant)) {
      continue;
    }
    assistant.reasoning_details = [
      ...(assistant.reasoning_details ?? []),
      { type: ReasoningDetailType.Text, text: REASONING_PLACEHOLDER },
    ];
    placeholderCount++;
  }
  return placeholderCount;
}

function makePlaceholderThinkingBlock(): Anthropic.ThinkingBlockParam {
  return { type: 'thinking', thinking: REASONING_PLACEHOLDER, signature: '' };
}

function addMessagesReasoningPlaceholders(request: GatewayMessagesRequest) {
  let placeholderCount = 0;
  for (const message of request.messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    if (typeof message.content === 'string') {
      message.content = [
        makePlaceholderThinkingBlock(),
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ];
      placeholderCount++;
      continue;
    }
    const hasThinking = message.content.some(
      block => block.type === 'thinking' && isNonEmptyString(block.thinking)
    );
    if (!hasThinking) {
      message.content.unshift(makePlaceholderThinkingBlock());
      placeholderCount++;
    }
  }
  return placeholderCount;
}

type ResponsesInputItem = OpenAI.Responses.ResponseInputItem;

const assistantOutputItemTypes = new Set<ResponsesInputItem['type']>([
  'reasoning',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'shell_call',
  'apply_patch_call',
  'computer_call',
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
  'mcp_call',
]);

/** Vercel merges a run of consecutive assistant output items into one assistant message. */
function isAssistantTurnItem(item: ResponsesInputItem) {
  return assistantOutputItemTypes.has(item.type) || ('role' in item && item.role === 'assistant');
}

function hasResponsesReasoning(item: ResponsesInputItem) {
  return (
    item.type === 'reasoning' &&
    [...item.summary, ...(item.content ?? [])].some(part => isNonEmptyString(part.text))
  );
}

function addResponsesReasoningPlaceholders(request: GatewayResponsesRequest) {
  if (!Array.isArray(request.input)) {
    return 0;
  }
  const input: ResponsesInputItem[] = [];
  let placeholderCount = 0;
  let turnStart: number | null = null;
  let turnHasReasoning = false;
  const closeTurn = () => {
    if (turnStart !== null && !turnHasReasoning) {
      input.splice(turnStart, 0, {
        type: 'reasoning',
        id: `rs_reasoning_unavailable_${placeholderCount++}`,
        summary: [{ type: 'summary_text', text: REASONING_PLACEHOLDER }],
      });
    }
    turnStart = null;
    turnHasReasoning = false;
  };
  for (const item of request.input) {
    if (isAssistantTurnItem(item)) {
      turnStart ??= input.length;
      turnHasReasoning ||= hasResponsesReasoning(item);
    } else {
      closeTurn();
    }
    input.push(item);
  }
  closeTurn();
  request.input = input;
  return placeholderCount;
}

/**
 * Reflection rejects requests where any earlier assistant message lacks
 * reasoning. Clients drop reasoning after a model switch, so every assistant
 * turn without reasoning text gets a placeholder.
 */
export function addReflectionReasoningPlaceholders(model: string, request: GatewayRequest) {
  const placeholderCount = (() => {
    switch (request.kind) {
      case 'chat_completions':
        return addChatCompletionsReasoningPlaceholders(request.body);
      case 'messages':
        return addMessagesReasoningPlaceholders(request.body);
      case 'responses':
        return addResponsesReasoningPlaceholders(request.body);
    }
  })();
  if (placeholderCount > 0) {
    console.warn(
      '[addReflectionReasoningPlaceholders] mutated request with reasoning placeholders',
      {
        model,
        requestKind: request.kind,
        placeholderCount,
      }
    );
  }
}
