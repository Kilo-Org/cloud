import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  createEvalToolDefinition,
  createSafeToolDefinitions,
} from '@/src/shared/agent-llm-harness';
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
import type { OnTurnUsage } from '@/src/shared/agent-llm-turn-runner-core';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';
import type { FetchLike } from '@/src/shared/auth';
import { executeEvalToolCall } from './agent-eval-runtime';
import { executeSafeToolCall } from './agent-safe-tool-runtime';
import { toDangerousToolCallEvents } from './agent-tool-call-events';

interface RunDangerousLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly selectedTabId: number;
  readonly onUsage?: OnTurnUsage | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly supportsImages?: boolean;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
  readonly updateThinkingBlock: (eventId: string, text: string) => void;
}

export const runDangerousLlmTurn = ({
  selectedTabId,
  supportsImages = false,
  ...options
}: RunDangerousLlmTurnOptions): Promise<void> =>
  runLlmTurn({
    ...options,
    executeToolCall: toolCall =>
      toolCall.name === 'eval' ? executeEvalToolCall(toolCall) : executeSafeToolCall(toolCall),
    failureMessage: error =>
      `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    maxToolRounds: maxAgentToolRounds,
    noResponseMessage: 'The model did not return a response.',
    supportsImages,
    toToolCallEvents: toolCalls => toDangerousToolCallEvents(toolCalls, selectedTabId),
    tooManyToolRoundsMessage:
      'The model requested too many eval rounds. Send another message to continue.',
    tools: [...createSafeToolDefinitions({ supportsImages }), createEvalToolDefinition()],
  });
