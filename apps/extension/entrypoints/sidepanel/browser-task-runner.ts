/* eslint-disable max-lines, import/max-dependencies, typescript/consistent-type-definitions -- The delegated adapter reuses the existing runner and settings contracts. */
import { browser } from '#imports';
import { browserFailureReasonSchema, browserResultSchema } from '@kilocode/cloud-agent-sdk/schemas';
import type { BrowserJobSnapshot, BrowserResult } from '@kilocode/cloud-agent-sdk/schemas';
import { z } from 'zod';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { loadAgentMemories } from '@/src/shared/agent-memories-storage';
import {
  loadMemorySettings,
  MEMORY_SETTINGS_STORAGE_KEY,
} from '@/src/shared/agent-memory-settings';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import {
  loadAgentWorkflows,
  loadWorkflowSettings,
  WORKFLOW_SETTINGS_STORAGE_KEY,
} from '@/src/shared/agent-workflows-storage';
import { browserApprovalSettingsSchema } from '@/src/shared/browser-provider-settings';
import type {
  BrowserApprovalSettings,
  BrowserProviderSettings,
} from '@/src/shared/browser-provider-settings';
import { loadRemoteMcpStore, REMOTE_MCP_STORAGE_KEY } from '@/src/shared/remote-mcp-storage';
import { listInspectableTabsWithTabsApi } from '@/src/shared/tab-debugger';
import { loadWebMcpSettings, WEB_MCP_SETTINGS_STORAGE_KEY } from '@/src/shared/web-mcp-settings';
import { formatSystemEnvironment } from './agent-chat-panel';
import { runBrowserTurn } from './browser-run-context';
import type { BrowserRunContext } from './browser-run-context';
import { requestApproval } from './pending-approval';

export type BrowserTaskStorage = BrowserRunContext['storage'];
export const getBrowserTaskTabs = () =>
  listInspectableTabsWithTabsApi({
    query: async () => {
      const tabs = await browser.tabs.query({});
      return tabs.flatMap(tab => {
        if (tab.id === undefined || tab.url === undefined) {
          return [];
        }
        return [{ id: tab.id, title: tab.title ?? tab.url, url: tab.url }];
      });
    },
  });

/** Only the provider's explicit defaults and current account settings enter consent. */
export const readBrowserTaskSettings = async (
  settings: BrowserProviderSettings,
  organizationId: string | undefined,
  storageArea: BrowserTaskStorage
): Promise<BrowserApprovalSettings> => {
  const selected = { ...settings };
  const [memorySettings, workflowSettings, webMcpSettings, remote] = await Promise.all([
    loadMemorySettings(storageArea),
    loadWorkflowSettings(storageArea),
    loadWebMcpSettings(storageArea),
    loadRemoteMcpStore(storageArea),
  ]);
  return browserApprovalSettingsSchema.parse({
    memorySettings,
    mode: selected.mode,
    model: selected.model,
    organizationId: organizationId ?? null,
    remoteMcpServers: remote.servers,
    thinkingEffort: selected.thinkingEffort,
    webMcpSettings,
    workflowSettings,
  });
};

const observationSchema = z.object({ text: z.string(), title: z.string(), url: z.url() });
const timeoutReasons = new Set([
  'queue_timeout',
  'approval_timeout',
  'execution_timeout',
  'invocation_expired',
]);
const failureStatus = (
  reason: Exclude<BrowserResult['reason'], 'completed'>
): Exclude<BrowserResult['status'], 'succeeded'> => {
  if (timeoutReasons.has(reason)) {
    return 'timed_out';
  }
  if (reason === 'cancelled') {
    return 'cancelled';
  }
  if (
    reason === 'approval_denied' ||
    reason === 'permission_denied' ||
    reason === 'runner_failed' ||
    reason === 'invalid_request' ||
    reason === 'unsupported'
  ) {
    return 'failed';
  }
  return 'interrupted';
};
export const browserTaskFailure = (
  job: BrowserJobSnapshot,
  reason: Exclude<BrowserResult['reason'], 'completed'>,
  effectsUncertain = false
): BrowserResult => ({
  browserTaskId: job.browserTaskId,
  effectsUncertain,
  evidence: [],
  invocationId: job.invocationId,
  jobId: job.jobId,
  providerId: job.providerId,
  reason,
  status: failureStatus(reason),
  summary: `Browser task stopped: ${reason}. Work is incomplete. Issued actions cannot be undone.${effectsUncertain ? ' Effects are uncertain; close affected tabs before explicit recovery.' : ''}`,
});

/** Evidence is observed page text, not model assertions, arbitrary tool JSON, or screenshot bytes. */
export const toBrowserTaskResult = (
  job: BrowserJobSnapshot,
  outcome: LlmTurnOutcome,
  events: readonly AgentConversationEvent[]
): BrowserResult => {
  const evidence: BrowserResult['evidence'] = outcome.toolResults
    .filter(
      result =>
        result.ok &&
        !result.effectsUncertain &&
        events.some(
          event =>
            event.type === 'tool-call' &&
            event.id === result.toolCallId &&
            event.name === 'get_page_snapshot'
        )
    )
    .flatMap(result => {
      const observation = observationSchema.safeParse(result.value);
      if (!observation.success) {
        return [];
      }
      const url = new URL(observation.data.url);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      const address = url.toString();
      const item = {
        ...(observation.data.text ? { text: observation.data.text.slice(0, 1024) } : {}),
        ...(observation.data.title ? { title: observation.data.title.slice(0, 128) } : {}),
        ...(address.length <= 2048 ? { url: address } : {}),
      };
      return Object.keys(item).length === 0 ? [] : [item];
    })
    .slice(0, 3);
  const handles = {
    browserTaskId: job.browserTaskId,
    invocationId: job.invocationId,
    jobId: job.jobId,
    providerId: job.providerId,
  };
  if (outcome.status === 'succeeded' && !outcome.effectsUncertain && outcome.summary.trim()) {
    return browserResultSchema.parse({
      ...handles,
      effectsUncertain: false,
      evidence,
      reason: 'completed',
      status: 'succeeded',
      summary: outcome.summary.slice(0, 4000),
    });
  }
  const parsed = browserFailureReasonSchema.safeParse(outcome.reason);
  let reason: Exclude<BrowserResult['reason'], 'completed'> = parsed.success
    ? parsed.data
    : 'runner_failed';
  if (outcome.reason === 'unsafe_tool_call') {
    reason = 'permission_denied';
  }
  if (outcome.effectsUncertain && !parsed.success) {
    reason = 'effects_uncertain';
  }
  const failed = browserTaskFailure(job, reason, outcome.effectsUncertain);
  return browserResultSchema.parse({
    ...failed,
    evidence,
    status: outcome.status === 'failed' && !outcome.effectsUncertain ? 'failed' : failed.status,
    summary: `${failed.summary}${outcome.summary.trim() ? ` Partial response: ${outcome.summary.slice(0, 4000)}` : ''}`,
  });
};

export type BrowserTaskRunInput = {
  readonly abort: AbortController;
  readonly apiBaseUrl: string;
  readonly events: readonly AgentConversationEvent[];
  readonly executionGuard: BrowserRunContext['executionGuard'];
  readonly fetch: BrowserRunContext['fetch'];
  readonly job: BrowserJobSnapshot;
  readonly lease: BrowserRunContext['lease'];
  readonly remoteFetch: typeof fetch;
  readonly settings: BrowserApprovalSettings;
  readonly storage: BrowserTaskStorage;
  readonly supportsImages: boolean;
  readonly token: string;
};

/** There is one production runner path. Tests inject its inputs, not a runtime bypass. */
export const runBrowserTask = async (input: BrowserTaskRunInput) => {
  let events = [...input.events];
  let entered = false;
  let ended = false;
  let outcome: LlmTurnOutcome = {
    effectsUncertain: false,
    reason: 'runner_failed',
    status: 'interrupted',
    summary: 'Browser execution did not start.',
    toolResults: [],
  };
  const guard = (): void => {
    input.abort.signal.throwIfAborted();
    input.lease.guard();
    input.executionGuard();
  };
  const settings = structuredClone(input.settings);
  const frozenSettings = new Map<string, unknown>([
    [MEMORY_SETTINGS_STORAGE_KEY, settings.memorySettings],
    [WORKFLOW_SETTINGS_STORAGE_KEY, settings.workflowSettings],
    [WEB_MCP_SETTINGS_STORAGE_KEY, settings.webMcpSettings],
  ]);
  const invocationStorage: BrowserTaskStorage = {
    getItem: async key => {
      if (frozenSettings.has(key)) {
        return structuredClone(frozenSettings.get(key));
      }
      if (key === REMOTE_MCP_STORAGE_KEY) {
        // Validate the exact OAuth read; a frozen whole store would overwrite unrelated live edits.
        const remote = await loadRemoteMcpStore(input.storage);
        guard();
        const changed = settings.remoteMcpServers.some(
          server =>
            server.enabled &&
            server.auth.type === 'oauth' &&
            JSON.stringify(remote.servers.find(candidate => candidate.id === server.id)?.auth) !==
              JSON.stringify(server.auth)
        );
        if (changed) {
          const stopped = new ExecutionStoppedError('permission_denied');
          input.abort.abort(stopped);
          throw stopped;
        }
        return remote;
      }
      return input.storage.getItem(key);
    },
    // Matching delegated draft cleanup remains possible after Stop; it cannot grant authority.
    removeItem: key => input.storage.removeItem(key),
    setItem: (key, value) => {
      guard();
      return input.storage.setItem(key, value);
    },
  };
  try {
    guard();
    const tab = input.job.approvedTab;
    const deadline = input.job.deadlines.execution;
    if (
      input.job.status !== 'running' ||
      tab === undefined ||
      deadline === undefined ||
      tab.effectiveMode !== settings.mode
    ) {
      throw new ExecutionStoppedError('invalid_request');
    }
    const tabs = await getBrowserTaskTabs();
    if (!tabs.some(candidate => candidate.id === tab.tabId)) {
      throw new ExecutionStoppedError('tab_lost');
    }
    const [memories, workflows] = await Promise.all([
      loadAgentMemories(invocationStorage),
      loadAgentWorkflows(invocationStorage),
    ]);
    guard();
    const selectedTab = { id: tab.tabId, title: tab.title, url: tab.url };
    const last = events.at(-1);
    if (last?.type !== 'message' || last.role !== 'user') {
      throw new ExecutionStoppedError('invalid_request');
    }
    const systemEnvironment = formatSystemEnvironment({ memories, selectedTab, workflows });
    events = [
      ...events.slice(0, -1),
      { ...last, ...(systemEnvironment === undefined ? {} : { systemEnvironment }) },
    ];
    const context: BrowserRunContext = {
      abort: input.abort,
      allowTabFallback: false,
      allowWebMcpInSafeMode: settings.webMcpSettings.allowWebMcpInSafeMode,
      apiBaseUrl: input.apiBaseUrl,
      appendEvents: appended => {
        events = [...events, ...appended];
      },
      executionGuard: guard,
      fetch: input.fetch,
      lease: input.lease,
      mode: settings.mode,
      model: settings.model,
      onRemoteMcpWarning: () => {},
      organizationId: settings.organizationId ?? undefined,
      remoteFetch: input.remoteFetch,
      remoteMcpServers: settings.remoteMcpServers,
      requestApproval: async (kind, draft) => {
        const approval = await requestApproval(invocationStorage, kind, draft, input.abort.signal, {
          executionGuard: guard,
          expiresAt: Date.parse(deadline),
          invocationId: input.job.invocationId,
          isLive: () => !ended && !input.abort.signal.aborted,
        });
        if (approval.status === 'rejected') {
          input.abort.abort(new ExecutionStoppedError('permission_denied'));
        }
        if (approval.status === 'failed') {
          input.abort.abort(new ExecutionStoppedError('runner_failed'));
        }
        guard();
        return approval;
      },
      selectedTab,
      settings: settings.workflowSettings,
      storage: invocationStorage,
      supportsImages: input.supportsImages,
      thinkingEffort: settings.thinkingEffort,
      token: input.token,
      updateAssistantMessage: (eventId, text) => {
        events = events.map(event =>
          event.id === eventId && event.type === 'message' ? { ...event, text } : event
        );
      },
      updateThinkingBlock: (eventId, text) => {
        events = events.map(event =>
          event.id === eventId && event.type === 'thinking' ? { ...event, text } : event
        );
      },
    };
    entered = true;
    outcome = await runBrowserTurn(context, events);
    // A final model response cannot revive a cancelled or expired invocation.
    guard();
  } catch (error) {
    const stopped = error instanceof ExecutionStoppedError ? error : undefined;
    outcome = {
      ...outcome,
      effectsUncertain: outcome.effectsUncertain || (stopped?.effectsUncertain ?? entered),
      reason: stopped?.reason ?? 'runner_failed',
      status: stopped?.status ?? 'interrupted',
      summary:
        stopped === undefined
          ? 'Browser execution was interrupted.'
          : `Browser execution stopped: ${stopped.reason}.`,
    };
  } finally {
    ended = true;
  }
  if (outcome.effectsUncertain && input.job.approvedTab !== undefined) {
    await input.lease.quarantine(input.job.approvedTab.tabId);
  }
  return { events, outcome, result: toBrowserTaskResult(input.job, outcome, events) };
};
