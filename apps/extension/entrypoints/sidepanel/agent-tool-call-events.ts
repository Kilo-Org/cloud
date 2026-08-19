import { z } from 'zod';
import {
  createEvalToolCall,
  createRemoteMcpToolCall,
  createSafeToolCall,
  createWebMcpToolCall,
  createWorkflowToolCall,
} from '@/src/shared/agent-conversation';
import type {
  AgentConversationEvent,
  RemoteMcpAgentToolName,
  RemoteMcpToolCallEvent,
  SafeToolName,
  WebMcpToolCallEvent,
  WorkflowToolCallEvent,
  WorkflowToolName,
} from '@/src/shared/agent-conversation';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import type { WebMcpToolRoute } from '@/src/shared/web-mcp-tools';

type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly name: 'eval' }>;
type DangerousToolCallEvent = EvalToolCallEvent | SafeToolCallEvent | WorkflowToolCallEvent;

const stringArgumentSchema = z.string();

const getStringArgument = (args: Record<string, unknown>, name: string): string | undefined => {
  const parsed = stringArgumentSchema.safeParse(args[name]);

  return parsed.success ? parsed.data : undefined;
};

// Models pass numeric arguments as numbers or numeric strings; accept both.
const numberArgumentSchema = z.coerce.number();

const getNumberArgument = (args: Record<string, unknown>, name: string): number | undefined => {
  if (args[name] === undefined || args[name] === null) {
    return undefined;
  }
  const parsed = numberArgumentSchema.safeParse(args[name]);

  return parsed.success && Number.isFinite(parsed.data) ? parsed.data : undefined;
};

const isSafeToolName = (name: string): name is SafeToolName =>
  name === 'find_in_page' ||
  name === 'get_element_details' ||
  name === 'get_memory' ||
  name === 'get_page_snapshot' ||
  name === 'get_viewport_screenshot' ||
  name === 'search_memories' ||
  name === 'web_search';

export const isWorkflowToolName = (name: string): name is WorkflowToolName =>
  name === 'delete_workflow' ||
  name === 'get_workflow' ||
  name === 'run_workflow' ||
  name === 'save_memory' ||
  name === 'save_workflow' ||
  name === 'search_workflows';

const toSafeToolCallEvent = (
  toolCall: KiloGatewayToolCallRequest,
  selectedTabId: number
): SafeToolCallEvent | undefined => {
  if (!isSafeToolName(toolCall.name)) {
    return undefined;
  }

  const elementId = getStringArgument(toolCall.arguments, 'elementId');
  const memoryId = getStringArgument(toolCall.arguments, 'memoryId');
  const query = getStringArgument(toolCall.arguments, 'query');
  const snapshotId = getStringArgument(toolCall.arguments, 'snapshotId');
  const textStart = getNumberArgument(toolCall.arguments, 'textStart');

  return createSafeToolCall({
    name: toolCall.name,
    providerToolCallId: toolCall.id,
    ...(elementId === undefined ? {} : { elementId }),
    ...(memoryId === undefined ? {} : { memoryId }),
    ...(query === undefined ? {} : { query }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    tabId: selectedTabId,
    ...(textStart === undefined ? {} : { textStart }),
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

export const isWorkflowToolCallEvent = (toolCall: {
  readonly name: string;
}): toolCall is WorkflowToolCallEvent => isWorkflowToolName(toolCall.name);

export const isWebMcpToolCallEvent = (toolCall: {
  readonly name: string;
}): toolCall is WebMcpToolCallEvent => 'webMcpOrigin' in toolCall;

export const toWebMcpToolCallEvents = (
  toolCalls: readonly {
    readonly arguments: Record<string, unknown>;
    readonly id: string;
    readonly name: string;
  }[],
  routes: ReadonlyMap<string, WebMcpToolRoute>
): WebMcpToolCallEvent[] =>
  toolCalls.flatMap(toolCall => {
    const route = routes.get(toolCall.name);

    if (route === undefined) {
      return [];
    }

    return [
      createWebMcpToolCall({
        arguments: toolCall.arguments,
        definitionSignature: route.definitionSignature,
        documentId: route.documentId,
        name: toolCall.name,
        providerToolCallId: toolCall.id,
        tabId: route.tabId,
        webMcpOrigin: route.origin,
      }),
    ];
  });

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

export const toWorkflowToolCallEvent = (
  toolCall: KiloGatewayToolCallRequest,
  selectedTabId: number
): WorkflowToolCallEvent | undefined => {
  if (!isWorkflowToolName(toolCall.name)) {
    return undefined;
  }

  return createWorkflowToolCall({
    arguments: toolCall.arguments,
    name: toolCall.name,
    providerToolCallId: toolCall.id,
    tabId: selectedTabId,
  });
};

export const toWorkflowToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number
): WorkflowToolCallEvent[] =>
  toolCalls.flatMap(toolCall => {
    const event = toWorkflowToolCallEvent(toolCall, selectedTabId);

    return event === undefined ? [] : [event];
  });

export const toDangerousToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number
): DangerousToolCallEvent[] => {
  const events: DangerousToolCallEvent[] = [];

  for (const toolCall of toolCalls) {
    if (isWorkflowToolName(toolCall.name)) {
      const event = toWorkflowToolCallEvent(toolCall, selectedTabId);

      if (event !== undefined) {
        events.push(event);
      }
    } else if (toolCall.name === 'eval') {
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
