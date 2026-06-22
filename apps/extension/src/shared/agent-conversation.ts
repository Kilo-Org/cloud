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

interface CreateEvalToolCallOptions {
  readonly code: string;
  readonly tabId: number;
}

interface CreateToolResultOptions {
  readonly error?: string;
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly value?: unknown;
}

interface PlanLocalDangerousAgentTurnOptions {
  readonly mode: AgentMode;
  readonly selectedTabId: number | undefined;
  readonly userText: string;
}

let nextEventId = 1;

const createEventId = (): string => {
  const id = `event-${nextEventId}`;
  nextEventId += 1;
  return id;
};

const looksLikePageInspectionPrompt = (text: string): boolean => {
  const normalizedText = text.toLowerCase();
  return (
    normalizedText.includes('html length') ||
    (normalizedText.includes('inspect') && normalizedText.includes('tab')) ||
    normalizedText.includes('page')
  );
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
  tabId,
}: CreateEvalToolCallOptions): AgentConversationEvent => ({
  code,
  id: createEventId(),
  name: 'eval',
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

export const planLocalDangerousAgentTurn = ({
  mode,
  selectedTabId,
  userText,
}: PlanLocalDangerousAgentTurnOptions): AgentConversationEvent[] => {
  if (selectedTabId === undefined) {
    return [createAssistantMessage('Pick a target tab first.')];
  }

  if (mode !== 'dangerous') {
    return [createAssistantMessage('Switch to dangerous mode before I can run eval in a tab.')];
  }

  if (looksLikePageInspectionPrompt(userText)) {
    return [
      createAssistantMessage('I will inspect the selected tab with eval.'),
      createEvalToolCall({
        code: 'return document.documentElement.outerHTML.length;',
        tabId: selectedTabId,
      }),
    ];
  }

  return [
    createAssistantMessage(
      'Dangerous mode is connected. For now, ask me to inspect the selected tab.'
    ),
  ];
};
