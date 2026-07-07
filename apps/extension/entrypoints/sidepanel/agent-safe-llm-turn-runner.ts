import type {
  AgentConversationEvent,
  RemoteMcpToolCallEvent,
} from '@/src/shared/agent-conversation';
import { createSafeToolDefinitions } from '@/src/shared/agent-llm-harness';
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
import type { OnTurnUsage } from '@/src/shared/agent-llm-turn-runner-core';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';
import type { FetchLike } from '@/src/shared/auth';
import type {
  KiloGatewayToolCallRequest,
  KiloGatewayToolDefinition,
} from '@/src/shared/kilo-api-client';
import type { EvalTabResult } from '@/src/shared/tab-debugger';
import { executeSafeToolCall } from './agent-safe-tool-runtime';
import {
  isRemoteMcpToolCallEvent,
  isRemoteMcpToolName,
  toSafeToolCallEvents,
} from './agent-tool-call-events';

interface RunSafeLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly remoteMcpTools?: KiloGatewayToolDefinition[] | undefined;
  readonly executeRemoteMcpToolCall?:
    | ((toolCall: RemoteMcpToolCallEvent) => Promise<EvalTabResult>)
    | undefined;
  readonly toRemoteMcpToolCallEvents?:
    | ((toolCalls: KiloGatewayToolCallRequest[]) => RemoteMcpToolCallEvent[])
    | undefined;
  readonly selectedTabId: number;
  readonly onUsage?: OnTurnUsage | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly supportsImages?: boolean;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
  readonly updateThinkingBlock: (eventId: string, text: string) => void;
}

type SafeRunToolCallEvent =
  | ReturnType<typeof toSafeToolCallEvents>[number]
  | RemoteMcpToolCallEvent;

export const runSafeLlmTurn = ({
  executeRemoteMcpToolCall,
  remoteMcpTools = [],
  selectedTabId,
  supportsImages = false,
  toRemoteMcpToolCallEvents,
  ...options
}: RunSafeLlmTurnOptions): Promise<void> =>
  runLlmTurn<SafeRunToolCallEvent>({
    ...options,
    // eslint-disable-next-line require-await -- async normalizes the sync no-executor error branch into the Promise<EvalTabResult> the runner expects.
    executeToolCall: async (toolCall): Promise<EvalTabResult> => {
      if (isRemoteMcpToolCallEvent(toolCall)) {
        return executeRemoteMcpToolCall === undefined
          ? { error: `Remote MCP tool ${toolCall.name} is no longer available.`, ok: false }
          : executeRemoteMcpToolCall(toolCall);
      }

      return executeSafeToolCall(toolCall);
    },
    failureMessage: error => (error instanceof Error ? error.message : 'Failed to run safe mode.'),
    maxToolRounds: maxAgentToolRounds,
    noResponseMessage: 'The model did not return a response.',
    supportsImages,
    toToolCallEvents: toolCalls =>
      toolCalls.flatMap<SafeRunToolCallEvent>(toolCall =>
        isRemoteMcpToolName(toolCall.name)
          ? (toRemoteMcpToolCallEvents?.([toolCall]) ?? [])
          : toSafeToolCallEvents([toolCall], selectedTabId)
      ),
    tooManyToolRoundsMessage:
      'The model requested too many safe read rounds. Send another message to continue.',
    tools: [...createSafeToolDefinitions({ supportsImages }), ...remoteMcpTools],
  });
