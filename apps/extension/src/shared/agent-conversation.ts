export type AgentMode = 'dangerous' | 'safe';

export type AgentConversationEvent =
  | {
      readonly id: string;
      readonly role: 'assistant' | 'user';
      readonly text: string;
      readonly type: 'message';
    }
  | {
      readonly code: string;
      readonly id: string;
      readonly name: 'eval';
      readonly providerToolCallId?: string;
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

interface CreateToolResultOptions {
  readonly error?: string;
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly value?: unknown;
}

let nextEventId = 1;

const createEventId = (): string => {
  const id = `event-${nextEventId}`;
  nextEventId += 1;
  return id;
};

export const createUserMessage = (text: string): AgentConversationEvent => ({
  id: createEventId(),
  role: 'user',
  text,
  type: 'message',
});

export const createAssistantMessage = (text: string): AgentConversationEvent => ({
  id: createEventId(),
  role: 'assistant',
  text,
  type: 'message',
});

export const createEvalToolCall = ({
  code,
  providerToolCallId,
  tabId,
}: CreateEvalToolCallOptions): AgentConversationEvent => ({
  code,
  id: createEventId(),
  name: 'eval',
  ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  tabId,
  type: 'tool-call',
});

export const createToolResult = ({
  error,
  ok,
  toolCallId,
  value,
}: CreateToolResultOptions): AgentConversationEvent => ({
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
