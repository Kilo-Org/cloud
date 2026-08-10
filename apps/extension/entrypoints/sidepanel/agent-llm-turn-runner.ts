/* eslint-disable import/max-dependencies */
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
import { executeWebSearchToolCall } from './agent-web-search-tool-runtime';
import {
  isRemoteMcpToolCallEvent,
  isRemoteMcpToolName,
  isWorkflowToolCallEvent,
  toDangerousToolCallEvents,
} from './agent-tool-call-events';
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
import type { WorkflowToolContext } from './agent-workflow-tool-runtime';

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
  readonly onAssistantStreaming?: ((eventId: string | undefined) => void) | undefined;
  readonly workflowTools?: KiloGatewayToolDefinition[] | undefined;
  readonly workflowToolContext?: WorkflowToolContext | undefined;
  readonly maxToolRounds?: number | undefined;
}

type DangerousToolCallEvent =
  | ReturnType<typeof toDangerousToolCallEvents>[number]
  | RemoteMcpToolCallEvent;

export const runDangerousLlmTurn = ({
  executeRemoteMcpToolCall,
  maxToolRounds = maxAgentToolRounds,
  remoteMcpTools = [],
  selectedTabId,
  supportsImages = false,
  toRemoteMcpToolCallEvents,
  workflowToolContext,
  workflowTools = [],
  ...options
}: RunDangerousLlmTurnOptions): Promise<void> =>
  runLlmTurn<DangerousToolCallEvent>({
    ...options,
    // eslint-disable-next-line require-await -- async normalizes the sync no-executor error branch into the Promise<EvalTabResult> the runner expects.
    executeToolCall: async (toolCall): Promise<EvalTabResult> => {
      if (isWorkflowToolCallEvent(toolCall)) {
        if (workflowToolContext === undefined) {
          return {
            error: `Workflow tool ${toolCall.name} is no longer available.`,
            ok: false,
          };
        }
        return executeWorkflowToolCall(toolCall, workflowToolContext);
      }

      if (isRemoteMcpToolCallEvent(toolCall)) {
        return executeRemoteMcpToolCall === undefined
          ? { error: `Remote MCP tool ${toolCall.name} is no longer available.`, ok: false }
          : executeRemoteMcpToolCall(toolCall);
      }

      if (toolCall.name === 'eval') {
        return executeEvalToolCall(toolCall);
      }

      if (toolCall.name === 'web_search') {
        return executeWebSearchToolCall(toolCall, {
          apiBaseUrl: options.apiBaseUrl,
          fetch: options.fetch,
          organizationId: options.organizationId,
          token: options.token,
        });
      }

      return executeSafeToolCall(toolCall);
    },
    failureMessage: error =>
      `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    maxToolRounds,
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
      ...workflowTools,
      ...remoteMcpTools,
    ],
  });
