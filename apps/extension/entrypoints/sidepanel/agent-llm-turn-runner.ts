/* eslint-disable import/max-dependencies */
import type {
  AgentConversationEvent,
  RemoteMcpToolCallEvent,
  WebMcpToolCallEvent,
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
import { buildWebMcpToolDefinitions } from '@/src/shared/web-mcp-tools';
import type { WebMcpToolRoute } from '@/src/shared/web-mcp-tools';
import { executeEvalToolCall } from './agent-eval-runtime';
import { createSafeToolExecutor } from './agent-safe-tool-runtime';
import {
  isRemoteMcpToolCallEvent,
  isRemoteMcpToolName,
  isWebMcpToolCallEvent,
  isWorkflowToolCallEvent,
  toDangerousToolCallEvents,
  toWebMcpToolCallEvents,
} from './agent-tool-call-events';
import { discoverWebMcpTools, executeWebMcpToolCall } from './agent-web-mcp-tool-runtime';
import { createWebSearchExecutor } from './agent-web-search-tool-runtime';
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
import type { WorkflowToolContext } from './agent-workflow-tool-runtime';

interface RunDangerousLlmTurnOptions {
  readonly allowWebMcpInSafeMode?: boolean;
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
  | RemoteMcpToolCallEvent
  | WebMcpToolCallEvent;

export const runDangerousLlmTurn = ({
  allowWebMcpInSafeMode: _allowWebMcpInSafeMode,
  executeRemoteMcpToolCall,
  maxToolRounds = maxAgentToolRounds,
  remoteMcpTools = [],
  selectedTabId,
  supportsImages = false,
  toRemoteMcpToolCallEvents,
  workflowToolContext,
  workflowTools = [],
  ...options
}: RunDangerousLlmTurnOptions): Promise<void> => {
  // One executor per turn: a fresh unchanged-snapshot memory, so a new conversation's first snapshot is served in full.
  const executeSafeToolCall = createSafeToolExecutor();
  // One executor per turn: it carries the abort signal and caps the searches this turn may bill.
  const runWebSearch = createWebSearchExecutor({
    apiBaseUrl: options.apiBaseUrl,
    fetch: options.fetch,
    organizationId: options.organizationId,
    signal: options.signal,
    token: options.token,
  });

  // The fixed tool set never changes within a turn; WebMCP page tools are appended per-request by prepareTools.
  const fixedTools = [
    ...createSafeToolDefinitions({ supportsImages }),
    createEvalToolDefinition(),
    ...workflowTools,
    ...remoteMcpTools,
  ];
  // Rebuilt on every discovery so a stale route can never resolve a later call.
  let webMcpRoutes: ReadonlyMap<string, WebMcpToolRoute> = new Map();

  return runLlmTurn<DangerousToolCallEvent>({
    ...options,
    // eslint-disable-next-line require-await -- async normalizes the sync no-executor error branch into the Promise<EvalTabResult> the runner expects.
    executeToolCall: async (toolCall): Promise<EvalTabResult> => {
      if (isWebMcpToolCallEvent(toolCall)) {
        return executeWebMcpToolCall(toolCall);
      }

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
        return runWebSearch(toolCall);
      }

      return executeSafeToolCall(toolCall);
    },
    failureMessage: error =>
      `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    maxToolRounds,
    noResponseMessage: 'The model did not return a response.',
    prepareTools: async () => {
      webMcpRoutes = new Map();

      const discovery = await discoverWebMcpTools(selectedTabId);

      if (discovery === undefined || discovery.documentId === '') {
        return fixedTools;
      }

      const {
        routes,
        tools: webMcpTools,
        warning,
      } = buildWebMcpToolDefinitions({
        documentId: discovery.documentId,
        tabId: selectedTabId,
        tools: discovery.tools,
      });
      webMcpRoutes = routes;

      if (warning !== undefined) {
        console.warn(warning);
      }

      return [...fixedTools, ...webMcpTools];
    },
    supportsImages,
    toToolCallEvents: toolCalls =>
      toolCalls.flatMap<DangerousToolCallEvent>(toolCall => {
        const webMcpEvents = toWebMcpToolCallEvents([toolCall], webMcpRoutes);

        if (webMcpEvents.length > 0) {
          return webMcpEvents;
        }

        return isRemoteMcpToolName(toolCall.name)
          ? (toRemoteMcpToolCallEvents?.([toolCall]) ?? [])
          : toDangerousToolCallEvents([toolCall], selectedTabId);
      }),
    tooManyToolRoundsMessage:
      'The model requested too many eval rounds. Send another message to continue.',
    tools: fixedTools,
  });
};
