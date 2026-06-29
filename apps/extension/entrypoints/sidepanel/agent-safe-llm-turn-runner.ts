import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { createSafeToolDefinitions } from '@/src/shared/agent-llm-harness';
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';
import type { FetchLike } from '@/src/shared/auth';
import { executeSafeToolCall } from './agent-safe-tool-runtime';
import { toSafeToolCallEvents } from './agent-tool-call-events';

interface RunSafeLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly selectedTabId: number;
  readonly signal?: AbortSignal | undefined;
  readonly supportsImages?: boolean;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
  readonly updateThinkingBlock: (eventId: string, text: string) => void;
}

export const runSafeLlmTurn = ({
  selectedTabId,
  supportsImages = false,
  ...options
}: RunSafeLlmTurnOptions): Promise<void> =>
  runLlmTurn({
    ...options,
    executeToolCall: executeSafeToolCall,
    failureMessage: error => (error instanceof Error ? error.message : 'Failed to run safe mode.'),
    maxToolRounds: maxAgentToolRounds,
    noResponseMessage: 'The model did not return a response.',
    supportsImages,
    toToolCallEvents: toolCalls => toSafeToolCallEvents(toolCalls, selectedTabId),
    tooManyToolRoundsMessage:
      'The model requested too many safe read rounds. Send another message to continue.',
    tools: createSafeToolDefinitions({ supportsImages }),
  });
