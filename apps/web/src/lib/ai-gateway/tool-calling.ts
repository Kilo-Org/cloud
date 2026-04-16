import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import crypto from 'crypto';
import type OpenAI from 'openai';

const BINARY_DATA_REPLACEMENT =
  'The tool result contained binary data (NUL characters detected). ' +
  'This usually means a binary file was read by mistake. ' +
  'Try a different approach that avoids reading binary files.';

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
      const toolName = toolCall.type === 'function' ? toolCall.function.name : 'unknown';
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
  if (!Array.isArray(requestToMutate.messages)) {
    return;
  }
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
      const toolName = toolCall.type === 'function' ? toolCall.function.name : 'unknown';
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

function sanitizeTextParts(parts: Array<{ type: string; text: string }>): void {
  for (const part of parts) {
    if ((part.type === 'text' || part.type === 'input_text') && containsNul(part.text)) {
      part.text = BINARY_DATA_REPLACEMENT;
    }
  }
}

function sanitizeChatCompletionsToolResults(body: OpenRouterChatCompletionRequest): void {
  if (!Array.isArray(body.messages)) return;

  // Build a map from tool_call_id → tool name
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role === 'assistant') {
      for (const call of msg.tool_calls ?? []) {
        if (call.type === 'function') {
          toolNameById.set(call.id, call.function.name);
        }
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
    } else if (Array.isArray(msg.content)) {
      sanitizeTextParts(msg.content);
    }
  }
}

function sanitizeResponsesToolResults(body: GatewayResponsesRequest): void {
  if (!Array.isArray(body.input)) return;

  // Build a map from call_id → tool name
  const toolNameById = new Map<string, string>();
  for (const item of body.input) {
    if (
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'function_call' &&
      'name' in item
    ) {
      toolNameById.set((item as { call_id: string }).call_id, (item as { name: string }).name);
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
      sanitizeTextParts(item.output as Array<{ type: string; text: string }>);
    }
  }
}

function sanitizeMessagesToolResults(body: GatewayMessagesRequest): void {
  if (!Array.isArray(body.messages)) return;

  // Build a map from tool_use_id → tool name
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
        sanitizeTextParts(block.content as Array<{ type: string; text: string }>);
      }
    }
  }
}
