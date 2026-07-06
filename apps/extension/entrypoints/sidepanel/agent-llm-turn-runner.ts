import type {
  AgentConversationEvent,
  RemoteMcpToolCallEvent,
} from '@/src/shared/agent-conversation';
import {
  createEvalToolDefinition,
  createSafeToolDefinitions,
} from '@/src/shared/agent-llm-harness';
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
import type { OnTurnUsage } from '@/src/shared/agent-llm-turn-runner-core';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';
import type { FetchLike } from '@/src/shared/auth';
import type {
  KiloGatewayToolCallRequest,
  KiloGatewayToolDefinition,
} from '@/src/shared/kilo-api-client';
import type { EvalTabResult } from '@/src/shared/tab-debugger';
import { executeEvalToolCall } from './agent-eval-runtime';
import { executeSafeToolCall } from './agent-safe-tool-runtime';
import {
  isRemoteMcpToolCallEvent,
  isRemoteMcpToolName,
  toDangerousToolCallEvents,
} from './agent-tool-call-events';

interface RunDangerousLlmTurnOptions {
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

type DangerousToolCallEvent =
  | ReturnType<typeof toDangerousToolCallEvents>[number]
  | RemoteMcpToolCallEvent;

export const runDangerousLlmTurn = ({
  executeRemoteMcpToolCall,
  remoteMcpTools = [],
  selectedTabId,
  supportsImages = false,
  toRemoteMcpToolCallEvents,
  ...options
}: RunDangerousLlmTurnOptions): Promise<void> =>
  runLlmTurn<DangerousToolCallEvent>({
    ...options,
    // eslint-disable-next-line require-await -- async normalizes the sync no-executor error branch into the Promise<EvalTabResult> the runner expects.
    executeToolCall: async (toolCall): Promise<EvalTabResult> => {
      if (isRemoteMcpToolCallEvent(toolCall)) {
        return executeRemoteMcpToolCall === undefined
          ? { error: `Remote MCP tool ${toolCall.name} is no longer available.`, ok: false }
          : executeRemoteMcpToolCall(toolCall);
      }

      return toolCall.name === 'eval'
        ? executeEvalToolCall(toolCall)
        : executeSafeToolCall(toolCall);
    },
    failureMessage: error =>
      `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    maxToolRounds: maxAgentToolRounds,
    noResponseMessage: 'The model did not return a response.',
    supportsImages,
    toToolCallEvents: toolCalls =>
      toolCalls.flatMap<DangerousToolCallEvent>(toolCall =>
        isRemoteMcpToolName(toolCall.name)
          ? (toRemoteMcpToolCallEvents?.([toolCall]) ?? [])
          : toDangerousToolCallEvents([toolCall], selectedTabId)
      ),
    tooManyToolRoundsMessage:
      'The model requested too many eval rounds. Send another message to continue.',
    tools: [
      ...createSafeToolDefinitions({ supportsImages }),
      createEvalToolDefinition(),
      ...remoteMcpTools,
    ],
  });
