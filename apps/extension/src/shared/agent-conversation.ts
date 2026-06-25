export type AgentMode = 'dangerous' | 'safe';
export type SafeToolName =
  | 'find_in_page'
  | 'get_element_details'
  | 'get_page_snapshot'
  | 'get_viewport_screenshot';
export type AgentToolName = 'eval' | SafeToolName;

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
      readonly name: SafeToolName;
      readonly providerToolCallId?: string;
      readonly query?: string;
      readonly reasoningDetails?: readonly unknown[];
      readonly snapshotId?: string;
      readonly tabId: number;
      readonly type: 'tool-call';
    }
  | {
      readonly error?: string;
      readonly id: string;
      readonly ok: boolean;
      readonly toolCallId: string;
      readonly type: 'tool-result';
      readonly value?: unknown;
    };

type MessageEvent = Extract<AgentConversationEvent, { readonly type: 'message' }>;
type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly name: 'eval' }>;
type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;

export type GroupedConversationItem =
  | {
      readonly event: AgentConversationEvent;
      readonly type: 'event';
    }
  | {
      readonly result: Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;
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
  readonly name: SafeToolName;
  readonly providerToolCallId?: string;
  readonly query?: string;
  readonly snapshotId?: string;
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
  name,
  providerToolCallId,
  query,
  snapshotId,
  tabId,
}: CreateSafeToolCallOptions): SafeToolCallEvent => ({
  id: createEventId(),
  name,
  ...(elementId === undefined ? {} : { elementId }),
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  ...(query === undefined ? {} : { query }),
  ...(snapshotId === undefined ? {} : { snapshotId }),
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

export const getConversationScrollKey = (items: GroupedConversationItem[]): string =>
  items
    .map(item => {
      if (item.type === 'tool-exchange') {
        return `${item.toolCall.id}:${item.result.id}`;
      }

      const { event } = item;

      return event.type === 'message' || event.type === 'thinking'
        ? `${event.id}:${event.text.length}`
        : event.id;
    })
    .join('|');
