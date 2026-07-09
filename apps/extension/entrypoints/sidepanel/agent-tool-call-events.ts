import { z } from 'zod';
import {
  createEvalToolCall,
  createRemoteMcpToolCall,
  createSafeToolCall,
} from '@/src/shared/agent-conversation';
import type {
  AgentConversationEvent,
  RemoteMcpAgentToolName,
  RemoteMcpToolCallEvent,
  SafeToolName,
} from '@/src/shared/agent-conversation';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';

type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly name: 'eval' }>;
type DangerousToolCallEvent = EvalToolCallEvent | SafeToolCallEvent;

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

export const isRemoteMcpToolName = (name: string): name is RemoteMcpAgentToolName =>
  name.startsWith('mcp_');

export const isRemoteMcpToolCallEvent = (toolCall: {
  readonly name: string;
}): toolCall is RemoteMcpToolCallEvent => isRemoteMcpToolName(toolCall.name);

/*
 * Always emit an event for an mcp_ call, even when its route is gone (server
 * removed/disabled mid-turn). The executor resolves the route again and returns
 * a normal tool error, so the model still gets a result for the call it made.
 */
export const toRemoteMcpToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  routes: ReadonlyMap<string, RemoteMcpToolRoute>
): RemoteMcpToolCallEvent[] =>
  toolCalls.flatMap(toolCall => {
    if (!isRemoteMcpToolName(toolCall.name)) {
      return [];
    }

    const route = routes.get(toolCall.name);

    return [
      createRemoteMcpToolCall({
        arguments: toolCall.arguments,
        name: toolCall.name,
        providerToolCallId: toolCall.id,
        remoteToolName: route?.remoteToolName ?? '',
        serverId: route?.serverId ?? '',
        serverName: route?.serverName ?? '',
      }),
    ];
  });

export const toDangerousToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number
): DangerousToolCallEvent[] => {
  const events: DangerousToolCallEvent[] = [];

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
