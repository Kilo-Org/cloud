import { z } from 'zod';
import { createEvalToolCall, createSafeToolCall } from '@/src/shared/agent-conversation';
import type { AgentConversationEvent, SafeToolName } from '@/src/shared/agent-conversation';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';

type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

const stringArgumentSchema = z.string();

const getStringArgument = (args: Record<string, unknown>, name: string): string | undefined => {
  const parsed = stringArgumentSchema.safeParse(args[name]);

  return parsed.success ? parsed.data : undefined;
};

const isSafeToolName = (name: string): name is SafeToolName =>
  name === 'find_in_page' ||
  name === 'get_element_details' ||
  name === 'get_page_snapshot' ||
  name === 'get_viewport_screenshot';

const toSafeToolCallEvent = (
  toolCall: KiloGatewayToolCallRequest,
  selectedTabId: number
): SafeToolCallEvent | undefined => {
  if (!isSafeToolName(toolCall.name)) {
    return undefined;
  }

  const elementId = getStringArgument(toolCall.arguments, 'elementId');
  const query = getStringArgument(toolCall.arguments, 'query');
  const snapshotId = getStringArgument(toolCall.arguments, 'snapshotId');

  return createSafeToolCall({
    name: toolCall.name,
    providerToolCallId: toolCall.id,
    ...(elementId === undefined ? {} : { elementId }),
    ...(query === undefined ? {} : { query }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    tabId: selectedTabId,
  });
};

export const toSafeToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number
): SafeToolCallEvent[] =>
  toolCalls.flatMap(toolCall => {
    const event = toSafeToolCallEvent(toolCall, selectedTabId);

    return event === undefined ? [] : [event];
  });

export const toDangerousToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number
): ToolCallEvent[] => {
  const events: ToolCallEvent[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name === 'eval') {
      const code = getStringArgument(toolCall.arguments, 'code');

      if (code !== undefined) {
        events.push(
          createEvalToolCall({
            code,
            providerToolCallId: toolCall.id,
            tabId: selectedTabId,
          })
        );
      }
    } else {
      const safeToolCall = toSafeToolCallEvent(toolCall, selectedTabId);

      if (safeToolCall !== undefined) {
        events.push(safeToolCall);
      }
    }
  }

  return events;
};
