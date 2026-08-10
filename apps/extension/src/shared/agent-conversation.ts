export type AgentMode = 'dangerous' | 'safe';
export type SafeToolName =
  | 'find_in_page'
  | 'get_element_details'
  | 'get_memory'
  | 'get_page_snapshot'
  | 'get_viewport_screenshot'
  | 'search_memories'
  | 'web_search';
export type WorkflowToolName =
  | 'delete_workflow'
  | 'get_workflow'
  | 'run_workflow'
  | 'save_memory'
  | 'save_workflow'
  | 'search_workflows';
export type RemoteMcpAgentToolName = `mcp_${string}`;
export type AgentToolName = 'eval' | RemoteMcpAgentToolName | SafeToolName | WorkflowToolName;

export type AgentConversationEvent =
  | {
      readonly id: string;
      readonly role: 'assistant' | 'user';
      readonly systemEnvironment?: string;
      readonly text: string;
      readonly type: 'message';
    }
  | {
      readonly id: string;
      readonly text: string;
      readonly type: 'thinking';
    }
  | {
      readonly code: string;
      readonly id: string;
      readonly name: 'eval';
      readonly providerToolCallId?: string;
      readonly reasoningDetails?: readonly unknown[];
      readonly tabId: number;
      readonly type: 'tool-call';
    }
  | {
      readonly elementId?: string;
      readonly id: string;
      readonly memoryId?: string;
      readonly name: SafeToolName;
      readonly providerToolCallId?: string;
      readonly query?: string;
      readonly reasoningDetails?: readonly unknown[];
      readonly snapshotId?: string;
      readonly tabId: number;
      readonly textStart?: number;
      readonly type: 'tool-call';
    }
  | {
      readonly arguments: Record<string, unknown>;
      readonly id: string;
      readonly name: RemoteMcpAgentToolName;
      readonly providerToolCallId?: string;
      readonly reasoningDetails?: readonly unknown[];
      readonly remoteToolName: string;
      readonly serverId: string;
      readonly serverName: string;
      readonly type: 'tool-call';
    }
  | {
      readonly arguments: Record<string, unknown>;
      readonly id: string;
      readonly name: WorkflowToolName;
      readonly providerToolCallId?: string;
      readonly reasoningDetails?: readonly unknown[];
      readonly tabId: number;
      readonly type: 'tool-call';
    }
  | {
      readonly arguments: Record<string, unknown>;
      readonly id: string;
      /** The agent's own tool name (`read`, `bash`, …), not an extension tool. */
      readonly name: string;
      /** Marks the agent-tool member so the renderer can branch on it. */
      readonly source: 'agent';
      /** The tool's own one-line summary of the call. */
      readonly title?: string;
      readonly type: 'tool-call';
    }
  | {
      readonly error?: string;
      readonly id: string;
      /** Image bytes for an agent tool result, from `agent-tool-images`. */
      readonly imageDataUrl?: string;
      readonly ok: boolean;
      readonly toolCallId: string;
      readonly type: 'tool-result';
      readonly value?: unknown;
    };

type MessageEvent = Extract<AgentConversationEvent, { readonly type: 'message' }>;
type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly name: 'eval' }>;
export type RemoteMcpToolCallEvent = Extract<
  AgentConversationEvent,
  { readonly name: RemoteMcpAgentToolName }
>;
export type WorkflowToolCallEvent = Extract<
  AgentConversationEvent,
  { readonly name: WorkflowToolName }
>;
type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;

export type GroupedConversationItem =
  | {
      readonly event: AgentConversationEvent;
      readonly type: 'event';
    }
  | {
      readonly result?: Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;
      readonly toolCall: Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
      readonly type: 'tool-exchange';
    };

interface CreateEvalToolCallOptions {
  readonly code: string;
  readonly providerToolCallId?: string;
  readonly tabId: number;
}

interface CreateSafeToolCallOptions {
  readonly elementId?: string;
  readonly memoryId?: string;
  readonly name: SafeToolName;
  readonly providerToolCallId?: string;
  readonly query?: string;
  readonly snapshotId?: string;
  readonly tabId: number;
  readonly textStart?: number;
}

interface CreateRemoteMcpToolCallOptions {
  readonly arguments: Record<string, unknown>;
  readonly name: RemoteMcpAgentToolName;
  readonly providerToolCallId?: string;
  readonly remoteToolName: string;
  readonly serverId: string;
  readonly serverName: string;
}

interface CreateWorkflowToolCallOptions {
  readonly arguments: Record<string, unknown>;
  readonly name: WorkflowToolName;
  readonly providerToolCallId?: string;
  readonly tabId: number;
}

interface CreateToolResultOptions {
  readonly error?: string;
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly value?: unknown;
}

// Per-session prefix so the reset-on-reload counter never reissues a restored id.
const eventIdSession = crypto.randomUUID();
let nextEventId = 1;

const createEventId = (): string => {
  const id = `event-${eventIdSession}-${nextEventId}`;
  nextEventId += 1;
  return id;
};

export const createUserMessage = (text: string, systemEnvironment?: string): MessageEvent => ({
  id: createEventId(),
  role: 'user',
  ...(systemEnvironment === undefined ? {} : { systemEnvironment }),
  text,
  type: 'message',
});

export const createAssistantMessage = (text: string): MessageEvent => ({
  id: createEventId(),
  role: 'assistant',
  text,
  type: 'message',
});

export const createThinkingBlock = (
  text: string
): Extract<AgentConversationEvent, { readonly type: 'thinking' }> => ({
  id: createEventId(),
  text,
  type: 'thinking',
});

export const createEvalToolCall = ({
  code,
  providerToolCallId,
  tabId,
}: CreateEvalToolCallOptions): EvalToolCallEvent => ({
  code,
  id: createEventId(),
  name: 'eval',
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  tabId,
  type: 'tool-call',
});

export const createSafeToolCall = ({
  elementId,
  memoryId,
  name,
  providerToolCallId,
  query,
  snapshotId,
  tabId,
  textStart,
}: CreateSafeToolCallOptions): SafeToolCallEvent => ({
  id: createEventId(),
  name,
  ...(elementId === undefined ? {} : { elementId }),
  ...(memoryId === undefined ? {} : { memoryId }),
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  ...(query === undefined ? {} : { query }),
  ...(snapshotId === undefined ? {} : { snapshotId }),
  tabId,
  ...(textStart === undefined ? {} : { textStart }),
  type: 'tool-call',
});

export const createRemoteMcpToolCall = ({
  arguments: toolArguments,
  name,
  providerToolCallId,
  remoteToolName,
  serverId,
  serverName,
}: CreateRemoteMcpToolCallOptions): RemoteMcpToolCallEvent => ({
  arguments: toolArguments,
  id: createEventId(),
  name,
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  remoteToolName,
  serverId,
  serverName,
  type: 'tool-call',
});

export const createWorkflowToolCall = ({
  arguments: toolArguments,
  name,
  providerToolCallId,
  tabId,
}: CreateWorkflowToolCallOptions): WorkflowToolCallEvent => ({
  arguments: toolArguments,
  id: createEventId(),
  name,
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  tabId,
  type: 'tool-call',
});

export const createToolResult = ({
  error,
  ok,
  toolCallId,
  value,
}: CreateToolResultOptions): ToolResultEvent => ({
  id: createEventId(),
  ok,
  toolCallId,
  type: 'tool-result',
  ...(error === undefined ? {} : { error }),
  ...(value === undefined ? {} : { value }),
});

export const groupConversationEvents = (
  events: AgentConversationEvent[]
): GroupedConversationItem[] => {
  const groupedItems: GroupedConversationItem[] = [];
  const consumedEventIds = new Set<string>();

  for (const event of events) {
    if (!consumedEventIds.has(event.id)) {
      if (event.type === 'tool-call') {
        const result = events.find(
          (
            candidate
          ): candidate is Extract<AgentConversationEvent, { readonly type: 'tool-result' }> =>
            candidate.type === 'tool-result' && candidate.toolCallId === event.id
        );

        if (result === undefined) {
          groupedItems.push({ event, type: 'event' });
        } else {
          consumedEventIds.add(result.id);
          groupedItems.push({ result, toolCall: event, type: 'tool-exchange' });
        }
      } else {
        groupedItems.push({ event, type: 'event' });
      }
    }
  }

  return groupedItems;
};

/* eslint-disable max-lines */
export const getConversationScrollKey = (items: GroupedConversationItem[]): string =>
  items
    .map(item => {
      if (item.type === 'tool-exchange') {
        return `${item.toolCall.id}:${item.result?.id ?? 'running'}`;
      }

      const { event } = item;

      return event.type === 'message' || event.type === 'thinking'
        ? `${event.id}:${event.text.length}`
        : event.id;
    })
    .join('|');
