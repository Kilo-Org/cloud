/* eslint-disable max-lines -- every gateway tool-call family converts through one module so the runners share one routing table. */
import { z } from 'zod';
import {
  createRemoteMcpToolCall,
  createSafeToolCall,
  createToolCall,
  createToolResult,
  createWebMcpToolCall,
  createWorkflowToolCall,
} from '@/src/shared/agent-conversation';
import type {
  AgentConversationEvent,
  AgentMode,
  KiloBrowserToolCallEvent,
  KiloBrowserToolName,
  RemoteMcpAgentToolName,
  RemoteMcpToolCallEvent,
  SafeToolName,
  WebMcpToolCallEvent,
  WorkflowToolCallEvent,
  WorkflowToolName,
} from '@/src/shared/agent-conversation';
import {
  KILO_BROWSER_TOOL_PREFIX,
  isSafeBrowserToolName,
} from '@/src/shared/browser-tool-contract';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import type { WebMcpToolRoute } from '@/src/shared/web-mcp-tools';

type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;
type DangerousToolCallEvent = SafeToolCallEvent | WorkflowToolCallEvent;

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
  name === 'get_memory' || name === 'search_memories' || name === 'web_search';

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

const KILO_BROWSER_TOOL_CALL_PREFIX = `${KILO_BROWSER_TOOL_PREFIX}browser_`;

export const isKiloBrowserToolCallName = (name: string): name is KiloBrowserToolName =>
  name.startsWith(KILO_BROWSER_TOOL_CALL_PREFIX);

export const isKiloBrowserToolCallEvent = (toolCall: {
  readonly name: string;
}): toolCall is KiloBrowserToolCallEvent => isKiloBrowserToolCallName(toolCall.name);

/** The upstream Playwright MCP name (`kilo_browser_click` -> `browser_click`). */
const toUpstreamToolName = (name: KiloBrowserToolName): string =>
  name.slice(KILO_BROWSER_TOOL_PREFIX.length);

// Pinned verbatim: the end-to-end spec asserts this text.
const toSafeModeRefusal = (name: KiloBrowserToolName): string =>
  `${name} is not read-only: safe mode exposes only the Playwright MCP tools the upstream server marks with readOnlyHint, and this tool does not carry it. Switch to danger mode to run it.`;

export type BrowserToolEvent = KiloBrowserToolCallEvent | ToolResultEvent;

/*
 * An exposed browser tool call becomes a tool call event with its upstream
 * arguments verbatim. A call the current mode does not expose becomes a
 * refusal tool result instead of a silent drop, so the model always gets an
 * answer for the call it made.
 */
export const toBrowserToolCallEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number,
  mode: AgentMode
): BrowserToolEvent[] =>
  toolCalls.flatMap((toolCall): BrowserToolEvent[] => {
    if (!isKiloBrowserToolCallName(toolCall.name)) {
      return [];
    }

    if (mode === 'safe' && !isSafeBrowserToolName(toUpstreamToolName(toolCall.name))) {
      return [
        createToolResult({
          error: toSafeModeRefusal(toolCall.name),
          ok: false,
          toolCallId: toolCall.id,
        }),
      ];
    }

    return [
      createToolCall({
        arguments: toolCall.arguments,
        name: toolCall.name,
        providerToolCallId: toolCall.id,
        tabId: selectedTabId,
      }),
    ];
  });

export const isRemoteMcpToolName = (name: string): name is RemoteMcpAgentToolName =>
  name.startsWith('mcp_');

/*
 * The turn-runner view of browser calls: every kilo_browser_* call gets a
 * tool-call event, and a safe-mode refusal arrives paired with the call it
 * answers, keyed to the call event's id, so the exchange renders as one card
 * and the model reads the refusal on the next request.
 */
export const toBrowserToolTurnEvents = (
  toolCalls: KiloGatewayToolCallRequest[],
  selectedTabId: number,
  mode: AgentMode
): (KiloBrowserToolCallEvent | ToolResultEvent)[] =>
  toolCalls.flatMap(toolCall => {
    const events = toBrowserToolCallEvents([toolCall], selectedTabId, mode);
    const [event] = events;

    if (event === undefined) {
      return [];
    }

    if (event.type === 'tool-call' || !isKiloBrowserToolCallName(toolCall.name)) {
      return [event];
    }

    const callEvent = createToolCall({
      arguments: toolCall.arguments,
      name: toolCall.name,
      providerToolCallId: toolCall.id,
      tabId: selectedTabId,
    });

    return [callEvent, { ...event, toolCallId: callEvent.id }];
  });

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
    } else {
      const safeToolCall = toSafeToolCallEvent(toolCall, selectedTabId);

      if (safeToolCall !== undefined) {
        events.push(safeToolCall);
      }
    }
  }

  return events;
};
