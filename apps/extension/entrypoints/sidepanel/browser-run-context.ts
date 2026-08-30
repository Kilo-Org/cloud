/* eslint-disable import/max-dependencies -- Shared setup wires the existing tool families without another runner. */
import { browser } from '#imports';
import { createToolResult } from '@/src/shared/agent-conversation';
import type {
  AgentConversationEvent,
  WorkflowToolCallEvent,
} from '@/src/shared/agent-conversation';
import { createWorkflowToolDefinitions } from '@/src/shared/agent-llm-harness';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';
import { ExecutionStoppedError, normalizeExecutionGuard } from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';
import type { AgentWorkflowSettings } from '@/src/shared/agent-workflows';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '@/src/shared/remote-mcp-storage';
import { buildRemoteMcpToolDefinitions } from '@/src/shared/remote-mcp-tools';
import { normalizeEvalTabResult } from '@/src/shared/tab-debugger';
import type { NormalizedEvalTabResult } from '@/src/shared/tab-debugger';
import { executeRemoteMcpToolCall } from './agent-remote-mcp-tool-runtime';
import { runDangerousLlmTurn, runSafeLlmTurn } from './agent-turn-runners';
import { toRemoteMcpToolCallEvents } from './agent-tool-call-events';
import { evalInTab, getTabUrl, navigateTab } from './agent-workflow-runtime';
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
import type { WorkflowToolContext } from './agent-workflow-tool-runtime';
import type { BrowserExecutionLease } from './browser-execution-lock';
import type { WorkflowRunRequest } from './workflow-settings-state';

type TurnOptions = Parameters<typeof runSafeLlmTurn>[0];
export type BrowserRunContext = Pick<
  TurnOptions,
  | 'apiBaseUrl'
  | 'appendEvents'
  | 'fetch'
  | 'model'
  | 'onAssistantStreaming'
  | 'onUsage'
  | 'organizationId'
  | 'supportsImages'
  | 'thinkingEffort'
  | 'token'
  | 'updateAssistantMessage'
  | 'updateThinkingBlock'
> & {
  readonly abort: AbortController;
  readonly executionGuard: ExecutionGuard;
  readonly lease: BrowserExecutionLease;
  readonly mode: 'safe' | 'dangerous';
  /** Local callers resolve their existing fallback before setup. Delegated callers must supply the approved tab. */
  readonly selectedTab: { readonly id: number; readonly title: string; readonly url: string };
  readonly allowTabFallback: false;
  readonly settings: AgentWorkflowSettings;
  readonly allowWebMcpInSafeMode: boolean;
  readonly remoteMcpServers: readonly RemoteMcpServer[];
  readonly remoteFetch: typeof fetch;
  readonly storage: WorkflowToolContext['storage'] & RemoteMcpStorageArea;
  readonly requestApproval: WorkflowToolContext['requestApproval'];
  readonly onRemoteMcpWarning: (warning: string | undefined) => void;
};

const workflowContext = (
  context: BrowserRunContext,
  guard: ExecutionGuard
): WorkflowToolContext => ({
  allowWorkflowsInSafeMode: context.settings.allowWorkflowsInSafeMode,
  evalInTab,
  executionGuard: guard,
  getTabUrl,
  mode: context.mode,
  navigateTab,
  requestApproval: context.requestApproval,
  selectedTabId: context.selectedTab.id,
  selectedTabTitle: context.selectedTab.title,
  selectedTabUrl: context.selectedTab.url,
  signal: context.abort.signal,
  storage: context.storage,
});

/** The lease covers the complete awaited call, including recursive model continuations and issued actions. */
const withBoundTab = <Result>(
  context: BrowserRunContext,
  work: (guard: ExecutionGuard) => Promise<Result>
): Promise<Result> =>
  context.lease.run(async leaseGuard => {
    const guard = normalizeExecutionGuard(() => {
      leaseGuard();
      context.executionGuard();
    }, context.abort.signal);
    const onRemoved = (tabId: number): void => {
      if (tabId === context.selectedTab.id) {
        context.abort.abort(new ExecutionStoppedError('tab_lost'));
      }
    };
    guard();
    browser.tabs.onRemoved.addListener(onRemoved);
    try {
      try {
        await browser.tabs.get(context.selectedTab.id);
      } catch {
        context.abort.abort(new ExecutionStoppedError('tab_lost'));
      }
      guard();
      return await work(guard);
    } finally {
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
  }, context.selectedTab.id);

export const runBrowserTurn = (
  context: BrowserRunContext,
  conversationEvents: AgentConversationEvent[]
): Promise<LlmTurnOutcome> =>
  withBoundTab(context, async guard => {
    const { routes, tools, warning } = buildRemoteMcpToolDefinitions({
      mode: context.mode,
      servers: context.remoteMcpServers,
    });
    context.onRemoteMcpWarning(warning);
    const runTurn = context.mode === 'dangerous' ? runDangerousLlmTurn : runSafeLlmTurn;
    const outcome = await runTurn({
      allowWebMcpInSafeMode: context.allowWebMcpInSafeMode,
      apiBaseUrl: context.apiBaseUrl,
      appendEvents: context.appendEvents,
      conversationEvents,
      executeRemoteMcpToolCall: (event, executionGuard) =>
        executeRemoteMcpToolCall({
          event,
          executionGuard: executionGuard ?? guard,
          fetch: context.remoteFetch,
          routes,
          servers: context.remoteMcpServers,
          signal: context.abort.signal,
          storageArea: context.storage,
        }),
      executionGuard: guard,
      fetch: context.fetch,
      maxToolRounds: maxAgentToolRounds,
      model: context.model,
      onAssistantStreaming: context.onAssistantStreaming,
      onUsage: context.onUsage,
      organizationId: context.organizationId,
      remoteMcpTools: tools,
      selectedTabId: context.selectedTab.id,
      signal: context.abort.signal,
      supportsImages: context.supportsImages === true,
      thinkingEffort: context.thinkingEffort,
      toRemoteMcpToolCallEvents: toolCalls => toRemoteMcpToolCallEvents(toolCalls, routes),
      token: context.token,
      updateAssistantMessage: context.updateAssistantMessage,
      updateThinkingBlock: context.updateThinkingBlock,
      workflowToolContext: workflowContext(context, guard),
      workflowTools: createWorkflowToolDefinitions({
        allowWorkflows: context.settings.allowWorkflowsInSafeMode,
        mode: context.mode,
      }),
    });
    if (outcome.effectsUncertain) {
      await context.lease.quarantine(context.selectedTab.id);
    }
    return outcome;
  });

export type BrowserWorkflowOutcome = LlmTurnOutcome & { readonly events: AgentConversationEvent[] };
export const runBrowserWorkflow = (
  context: BrowserRunContext,
  toolCall: WorkflowToolCallEvent
): Promise<BrowserWorkflowOutcome> =>
  withBoundTab(context, async guard => {
    let result: NormalizedEvalTabResult = {
      effectsUncertain: false,
      error: 'Workflow did not start.',
      ok: false,
    };
    // eslint-disable-next-line init-declarations -- Only an interrupted workflow supplies this reason.
    let stopped: ExecutionStoppedError | undefined;
    try {
      result = normalizeEvalTabResult(
        await executeWorkflowToolCall(toolCall, workflowContext(context, guard))
      );
    } catch (error) {
      stopped = error instanceof ExecutionStoppedError ? error : undefined;
      result = {
        effectsUncertain: stopped?.effectsUncertain ?? true,
        error: error instanceof Error ? error.message : 'Workflow execution was interrupted.',
        ok: false,
      };
    }
    // Consume uncertainty before converting events or permitting the next model turn.
    if (result.effectsUncertain) {
      await context.lease.quarantine(context.selectedTab.id);
    }
    const event = {
      ...createToolResult({
        ok: result.ok && !result.effectsUncertain,
        toolCallId: toolCall.id,
        ...(result.ok && !result.effectsUncertain
          ? { value: result.value }
          : { error: result.ok ? 'Workflow completion is uncertain.' : result.error }),
      }),
      effectsUncertain: result.effectsUncertain,
    };
    const details = {
      effectsUncertain: result.effectsUncertain,
      events: [toolCall, event],
      summary: result.ok ? 'Workflow completed.' : result.error,
      toolResults: result.effectsUncertain ? [] : [event],
    };
    if (result.effectsUncertain) {
      return { ...details, reason: 'effects_uncertain', status: 'interrupted' };
    }
    if (stopped !== undefined) {
      return { ...details, reason: stopped.reason, status: stopped.status };
    }
    return result.ok
      ? { ...details, reason: 'completed', status: 'succeeded' }
      : { ...details, reason: 'model_failure', status: 'failed' };
  });

// Preserve the old request atom shape. The UI-only reservation is not model input or persisted state.
const workflowReservations = new WeakMap<
  WorkflowRunRequest,
  { lease: BrowserExecutionLease; conversationId: string | undefined }
>();
export const reserveWorkflowLease = (
  request: WorkflowRunRequest,
  lease: BrowserExecutionLease,
  conversationId: string | undefined
): void => {
  workflowReservations.set(request, { conversationId, lease });
};
export const takeWorkflowLease = (request: WorkflowRunRequest) => {
  const reserved = workflowReservations.get(request);
  workflowReservations.delete(request);
  return reserved;
};
