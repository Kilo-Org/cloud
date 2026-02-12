import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import crypto from 'crypto';
import type OpenAI from 'openai';

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

export const ENABLE_TOOL_REPAIR = true;

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
