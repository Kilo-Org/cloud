import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import crypto from 'crypto';
import type OpenAI from 'openai';

const BINARY_DATA_REPLACEMENT =
  'Error: the file appears to be binary — it contains NUL bytes that cannot ' +
  'be represented as text. Do not retry reading it. Treat this file as binary, ' +
  'skip it, or use a tool appropriate for its format (for example, image or ' +
  'PDF tools) instead.';

function normalizeToolCallId(toolCallId: string, maxIdLength: number | undefined) {
  return crypto.hash('sha256', toolCallId).slice(0, maxIdLength);
}

export function dropToolStrictProperties(requestToMutate: OpenRouterChatCompletionRequest) {
  for (const tool of requestToMutate.tools ?? []) {
    if (tool.type === 'function') {
      delete tool.function.strict;
    }
  }
}

export function normalizeToolCallIds(
  requestToMutate: OpenRouterChatCompletionRequest,
  filter: (toolCallId: string) => boolean,
  maxIdLength: number | undefined
) {
  for (const msg of requestToMutate.messages) {
    if (msg.role === 'assistant') {
      for (const toolCall of msg.tool_calls ?? []) {
        if (filter(toolCall.id)) {
          toolCall.id = normalizeToolCallId(toolCall.id, maxIdLength);
        }
      }
    }
    if (msg.role === 'tool' && filter(msg.tool_call_id)) {
      msg.tool_call_id = normalizeToolCallId(msg.tool_call_id, maxIdLength);
    }
  }
}

function groupByAssistantMessage(messages: OpenAI.ChatCompletionMessageParam[]) {
  const groups = new Array<{
    assistantMessage?: OpenAI.ChatCompletionAssistantMessageParam;
    otherMessages: OpenAI.ChatCompletionMessageParam[];
  }>();

  groups.push({
    assistantMessage: undefined,
    otherMessages: [],
  });

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      groups.push({
        assistantMessage: msg,
        otherMessages: [],
      });
    } else {
      const lastGroup = groups.at(-1);
      if (lastGroup) lastGroup.otherMessages.push(msg);
    }
  }

  return groups;
}

function deduplicateToolUses(assistantMessage: OpenAI.ChatCompletionAssistantMessageParam) {
  if (!assistantMessage.tool_calls) {
    return;
  }
  const toolCallIds = new Set<string>();
  assistantMessage.tool_calls = assistantMessage.tool_calls.filter(toolCall => {
    if (toolCallIds.has(toolCall.id)) {
      const toolName = toolCall.type === 'function' ? toolCall.function?.name : 'unknown';
      console.warn(
        `[repairTools] removing duplicate use of tool ${toolName} with tool call id ${toolCall.id}`
      );
      return false;
    }
    toolCallIds.add(toolCall.id);
    return true;
  });
}

export function repairTools(requestToMutate: OpenRouterChatCompletionRequest) {
  const groups = groupByAssistantMessage(requestToMutate.messages);

  for (const group of groups) {
    if (group.assistantMessage) {
      deduplicateToolUses(group.assistantMessage);
    }

    const toolCallIdsToVerify = new Set<string>();

    // Insert missing tool results
    const missingResults = new Array<OpenAI.ChatCompletionToolMessageParam>();
    for (const toolCall of group.assistantMessage?.tool_calls ?? []) {
      toolCallIdsToVerify.add(toolCall.id);
      if (
        group.otherMessages.some(msg => msg.role === 'tool' && msg.tool_call_id === toolCall.id)
      ) {
        continue;
      }
      const toolName = toolCall.type === 'function' ? toolCall.function?.name : 'unknown';
      console.warn(
        `[repairTools] inserting missing result for tool ${toolName} with tool call id ${toolCall.id}`
      );
      missingResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Tool execution was interrupted before completion.',
      });
    }
    group.otherMessages.splice(0, 0, ...missingResults);

    // Delete duplicate and orphan tool results
    group.otherMessages = group.otherMessages.filter(message => {
      if (message.role === 'tool' && !toolCallIdsToVerify.delete(message.tool_call_id)) {
        console.warn(
          `[repairTools] deleting duplicate/orphan tool result for tool call id ${message.tool_call_id}`
        );
        return false;
      }
      return true;
    });
  }

  // Flatten the groups back into a single array of messages
  requestToMutate.messages = groups.flatMap(g =>
    g.assistantMessage ? [g.assistantMessage, ...g.otherMessages] : g.otherMessages
  );
}

export function hasAttemptCompletionTool(request: OpenRouterChatCompletionRequest) {
  return (request.tools ?? []).some(
    tool => tool.type === 'function' && tool.function?.name === 'attempt_completion'
  );
}

function containsNul(value: string): boolean {
  return value.includes('\0');
}

// Only sanitize results for the "read" tool — the name used by KiloClaw and OpenCode.
const SANITIZED_TOOL_NAME = 'read';

/**
 * Replace tool result content that contains NUL ('\0') characters with a
 * message explaining the tool probably accidentally read binary data.
 * Limited to the "read" tool to avoid false positives on tools that
 * legitimately return binary-ish content.
 */
export function sanitizeBinaryToolResults(request: GatewayRequest): void {
  if (request.kind === 'chat_completions') {
    sanitizeChatCompletionsToolResults(request.body);
  } else if (request.kind === 'responses') {
    sanitizeResponsesToolResults(request.body);
  } else {
    sanitizeMessagesToolResults(request.body);
  }
}

function sanitizeTextPart(part: unknown): void {
  if (typeof part !== 'object' || part === null) return;
  if (!('type' in part) || (part.type !== 'text' && part.type !== 'input_text')) return;
  if (!('text' in part) || typeof part.text !== 'string') return;
  if (!containsNul(part.text)) return;
  part.text = BINARY_DATA_REPLACEMENT;
}

function sanitizeChatCompletionsToolResults(body: OpenRouterChatCompletionRequest): void {
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role !== 'assistant') continue;
    for (const call of msg.tool_calls ?? []) {
      if (call.type === 'function' && call.function?.name) {
        toolNameById.set(call.id, call.function.name);
      }
    }
  }

  for (const msg of body.messages) {
    if (msg.role !== 'tool') continue;
    if (toolNameById.get(msg.tool_call_id) !== SANITIZED_TOOL_NAME) continue;
    if (typeof msg.content === 'string') {
      if (containsNul(msg.content)) {
        console.warn('[sanitizeBinaryToolResults] replacing chat_completions tool result');
        msg.content = BINARY_DATA_REPLACEMENT;
      }
    } else {
      for (const part of msg.content) sanitizeTextPart(part);
    }
  }
}

function sanitizeResponsesToolResults(body: GatewayResponsesRequest): void {
  if (!Array.isArray(body.input)) return;

  const toolNameById = new Map<string, string>();
  for (const item of body.input) {
    if (item.type === 'function_call' && typeof item.name === 'string') {
      toolNameById.set(item.call_id, item.name);
    }
  }

  for (const item of body.input) {
    if (item.type !== 'function_call_output') continue;
    if (toolNameById.get(item.call_id) !== SANITIZED_TOOL_NAME) continue;
    if (typeof item.output === 'string') {
      if (containsNul(item.output)) {
        console.warn('[sanitizeBinaryToolResults] replacing responses function_call_output');
        item.output = BINARY_DATA_REPLACEMENT;
      }
    } else if (Array.isArray(item.output)) {
      for (const part of item.output) sanitizeTextPart(part);
    }
  }
}

function sanitizeMessagesToolResults(body: GatewayMessagesRequest): void {
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block === 'object' && block.type === 'tool_use') {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  for (const msg of body.messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block !== 'object' || block.type !== 'tool_result') continue;
      if (toolNameById.get(block.tool_use_id) !== SANITIZED_TOOL_NAME) continue;
      if (typeof block.content === 'string') {
        if (containsNul(block.content)) {
          console.warn('[sanitizeBinaryToolResults] replacing Anthropic tool_result');
          block.content = BINARY_DATA_REPLACEMENT;
        }
      } else if (Array.isArray(block.content)) {
        for (const part of block.content) sanitizeTextPart(part);
      }
    }
  }
}
