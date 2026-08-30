/* eslint-disable import/max-dependencies, max-lines */
import { browser, storage } from '#imports';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { AlertTriangle } from 'lucide-react';
import {
  compactingConversationIdsAtom,
  contextUsageAtomFamily,
  draftAtomFamily,
  evictConversationAtoms,
  queuedMessageAtomFamily,
  remoteMcpStoreAtom,
  runningConversationIdsAtom,
  sessionCostAtomFamily,
  streamingMessageIdAtomFamily,
} from './agent-chat-atoms';
import {
  appendQueuedMessage,
  resolveSendAction,
  shouldSendQueuedMessage,
} from './agent-message-queue';
import {
  createAssistantMessage,
  createUserMessage,
  createWorkflowToolCall,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  KEEP_RECENT_EXCHANGES,
  KEEP_RECENT_EXCHANGES_MANUAL,
  compactConversationEvents,
  hasCompactableHistory,
} from '@/src/shared/agent-context-compaction';
import type { TurnUsage } from '@/src/shared/agent-llm-turn-runner-core';
import { defaultMode } from '@/src/shared/agent-chat-placeholder';
import {
  captureEvent,
  CONVERSATION_CREATED_EVENT,
  MESSAGE_SENT_EVENT,
} from '@/src/shared/analytics';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import {
  closeStoredConversationTab,
  createNextStoredConversation,
  deleteStoredConversation,
  getActiveStoredConversation,
  getOpenStoredConversations,
  getSortedStoredConversationHistory,
  isStoredConversationEmpty,
  isStoredConversationOpen,
  openStoredConversation,
  setActiveStoredConversation,
  updateStoredConversationEvents,
  updateStoredConversationSettings,
  useStoredAgentConversations,
} from './agent-conversation-storage';
import { AgentFooterControls } from './agent-footer-controls';
import { ContextDonut } from './context-donut';
import {
  getBrowserExecutionCoordinator,
  QUARANTINE_MESSAGE,
  useBrowserExecutionSnapshot,
} from './browser-execution-lock';
import type { BrowserExecutionLease } from './browser-execution-lock';
import { runBrowserTurn, runBrowserWorkflow, takeWorkflowLease } from './browser-run-context';
import type { BrowserRunContext } from './browser-run-context';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import type { WorkflowRunRequest } from './workflow-settings-state';
import { formatAgentWorkflowIndex } from '@/src/shared/agent-workflows';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';
import { loadWorkflowSettings } from '@/src/shared/agent-workflows-storage';
import { loadWebMcpSettings } from '@/src/shared/web-mcp-settings';
import { AUTO_COMPACT_RATIO, getContextRatio } from '@/src/shared/context-usage';
import { addSessionCost } from '@/src/shared/session-cost';
import { getActiveTabId, useTabDebugger } from './use-tab-debugger';
import { ConversationList } from './conversation-list';
import { ConversationTabs } from './conversation-tabs';
import { MessageComposer } from './message-composer';
import { ConversationHistoryButton } from './conversation-history-button';
import { useGatewayModels } from './use-gateway-models';
import { loadRemoteMcpStore } from '@/src/shared/remote-mcp-storage';
import { connectAndPersistRemoteMcpServer } from './remote-mcp-client';
import { useAgentMemories } from './use-agent-memories';
import { useAgentWorkflows } from './use-agent-workflows';
import type { AgentMemory } from '@/src/shared/agent-memories';
import { formatAgentMemoryIndex } from '@/src/shared/agent-memories';
import { requestApproval } from './pending-approval';
import { workflowRunRequestAtom } from './workflow-settings-state';
import { activeConversationIdAtom, conversationModeAtom } from './settings-dialog-state';
import { sanitizeTabContextText, sanitizeTabContextUrl } from '@/src/shared/tab-context-sanitize';

const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
const emptyDefaultConversationEvents = (): AgentConversationEvent[] => [];
const recoveryGuidance = 'Browser execution stopped. Submit new work explicitly after recovery.';

interface ConversationRunState {
  readonly abort: AbortController;
  readonly selectedTabId: number;
  readonly token: number;
}

interface PendingAdmission {
  readonly signal: AbortSignal;
  readonly queued?: string;
}

export const getSelectedInspectableTabId = ({
  activeTabId,
  inspectableTabs,
  selectedTabId,
}: {
  readonly activeTabId?: number | undefined;
  readonly inspectableTabs: readonly { readonly id: number }[];
  readonly selectedTabId: number | undefined;
}): number | undefined => {
  if (selectedTabId !== undefined && inspectableTabs.some(tab => tab.id === selectedTabId)) {
    return selectedTabId;
  }

  if (activeTabId !== undefined && inspectableTabs.some(tab => tab.id === activeTabId)) {
    return activeTabId;
  }

  return inspectableTabs[0]?.id;
};

export const formatSystemEnvironment = ({
  selectedTab,
  memories,
  workflows,
}: {
  readonly selectedTab: { readonly title: string; readonly url: string } | undefined;
  readonly memories: readonly AgentMemory[];
  readonly workflows?: readonly AgentWorkflow[];
}): string | undefined => {
  if (selectedTab === undefined) {
    return undefined;
  }

  const lines = [
    `Selected tab title: ${sanitizeTabContextText(selectedTab.title)}`,
    `Selected tab URL: ${sanitizeTabContextUrl(selectedTab.url)}`,
    `Current time: ${new Date().toISOString()}`,
    `Timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  ];
  const memoryIndex = formatAgentMemoryIndex(memories);
  const workflowIndex =
    workflows === undefined ? undefined : formatAgentWorkflowIndex(workflows, selectedTab.url);
  const body = [lines.join('\n'), memoryIndex, workflowIndex].filter(Boolean).join('\n');

  return `<system_environment>\n${body}\n</system_environment>`;
};

export const formatSelectedTabSystemEnvironment = ({
  title,
  url,
}: {
  readonly title: string;
  readonly url: string;
}): string =>
  formatSystemEnvironment({ memories: [], selectedTab: { title, url }, workflows: [] }) ?? '';

export const AgentChatPanel = ({
  auth,
  isVisible = true,
  onHeaderBeforeSettingsChange,
  organizationId,
}: {
  auth: StoredAuth;
  readonly isVisible?: boolean;
  onHeaderBeforeSettingsChange?: (node?: ReactNode) => void;
  organizationId: string | undefined;
}): JSX.Element | null => {
  const store = useStore();
  const [conversationStore, setConversationStore, isConversationStoreLoaded] =
    useStoredAgentConversations(emptyDefaultConversationEvents);
  const { memories } = useAgentMemories();
  const { workflows } = useAgentWorkflows();
  const runningConversationIds = useAtomValue(runningConversationIdsAtom);
  const setRunningConversationIds = useSetAtom(runningConversationIdsAtom);
  const compactingConversationIds = useAtomValue(compactingConversationIdsAtom);
  const setCompactingConversationIds = useSetAtom(compactingConversationIdsAtom);
  const conversationStoreRef = useRef(conversationStore);
  const memoriesRef = useRef(memories);
  const workflowsRef = useRef(workflows);
  const runStatesRef = useRef(new Map<string, ConversationRunState>());
  const runTokenRef = useRef(0);
  const execution = useBrowserExecutionSnapshot();
  const [admissionBlocker, setAdmissionBlocker] = useState<string>();
  const mountedRef = useRef(true);
  const pendingAdmissionsRef = useRef(new Map<string, PendingAdmission>());
  const [pendingAdmissionIds, setPendingAdmissionIds] = useState<string[]>([]);
  const [pendingWorkflowAdmission, setPendingWorkflowAdmission] = useState<{
    request: WorkflowRunRequest;
    conversationId: string;
    isResuming: boolean;
  }>();
  const admissionControllersRef = useRef(new Map<string, AbortController>());
  const pausedQueuesRef = useRef(new Set<string>());
  const [pausedQueueIds, setPausedQueueIds] = useState<string[]>([]);
  // eslint-disable-next-line unicorn/no-useless-undefined -- React 19 requires an initial ref value.
  const blockedWorkflowRef = useRef<WorkflowRunRequest | undefined>(undefined);
  const processingWorkflowsRef = useRef(new Map<WorkflowRunRequest, string>());
  const [workflowResume, setWorkflowResume] = useState(0);
  const [remoteMcpToolWarning, setRemoteMcpToolWarning] = useState<string>();
  const [pendingCreateDefaultConversationId, setPendingCreateDefaultConversationId] = useState<
    string | undefined
  >();
  const { activeTabId, inspectableTabs, isLoadingTabs, tabDebuggerError } = useTabDebugger();
  const inspectableTabsRef = useRef(inspectableTabs);
  const isCreateDefaultInFlightRef = useRef(false);
  const { modelLoadError, modelOptions, refetchModels } = useGatewayModels({
    auth,
    organizationId,
  });
  const activeConversation = getActiveStoredConversation(conversationStore);
  const { events, id: activeConversationId, mode = defaultMode } = activeConversation;
  const selectedTabId = getSelectedInspectableTabId({
    activeTabId,
    inspectableTabs,
    selectedTabId: activeConversation.selectedTabId,
  });
  inspectableTabsRef.current = inspectableTabs;
  const model = activeConversation.model ?? '';
  const selectedModel = useMemo(
    () => modelOptions.find(option => option.id === model),
    [model, modelOptions]
  );
  const openConversations = useMemo(
    () => getOpenStoredConversations(conversationStore),
    [conversationStore]
  );
  const historyConversations = useMemo(
    () => getSortedStoredConversationHistory(conversationStore),
    [conversationStore]
  );
  const groupedEvents = useMemo(() => groupConversationEvents(events), [events]);
  const thinkingOptions = useMemo(
    () => (selectedModel === undefined ? [] : selectedModel.variants),
    [selectedModel]
  );
  const thinkingEffort = activeConversation.thinkingEffort ?? thinkingOptions[0] ?? '';
  const isRunning = runningConversationIds.includes(activeConversationId);
  const isCompacting = compactingConversationIds.includes(activeConversationId);
  const activeUsage = useAtomValue(contextUsageAtomFamily(activeConversationId));
  const activePromptTokens = activeUsage?.promptTokens ?? 0;
  const activeSessionCostUsd = useAtomValue(sessionCostAtomFamily(activeConversationId));
  const streamingMessageId = useAtomValue(streamingMessageIdAtomFamily(activeConversationId));
  const activeQueuedMessage = useAtomValue(queuedMessageAtomFamily(activeConversationId));
  const contextLength = selectedModel?.contextLength;

  // Wire the settings-dialog outreach atoms so WorkflowSettings can read the
  // Active conversation's mode and id when the settings panel is open.
  const setConversationMode = useSetAtom(conversationModeAtom);
  const setActiveConversationId = useSetAtom(activeConversationIdAtom);
  useEffect(() => {
    setConversationMode(mode);
    setActiveConversationId(activeConversationId);
  }, [mode, activeConversationId, setConversationMode, setActiveConversationId]);

  const compactConversation = useCallback(
    async (
      conversationId: string,
      keepRecentExchanges: number = KEEP_RECENT_EXCHANGES
    ): Promise<void> => {
      if (
        !isConversationStoreLoaded ||
        store.get(runningConversationIdsAtom).includes(conversationId) ||
        store.get(compactingConversationIdsAtom).includes(conversationId)
      ) {
        return;
      }

      const conversation = conversationStoreRef.current.conversations.find(
        item => item.id === conversationId
      );
      const runModel = conversation?.model ?? '';

      if (conversation === undefined || !isModelInCatalog(runModel)) {
        return;
      }

      setCompactingConversationIds(current => [...current, conversationId]);

      try {
        const compacted = await compactConversationEvents({
          apiBaseUrl,
          events: conversation.events,
          fetch: fetchFromWindow,
          keepRecentExchanges,
          model: runModel,
          organizationId,
          token: auth.token,
        });

        if (compacted !== undefined) {
          // Wholesale replace is safe only because the conversation can't receive new events while compacting (guarded above + send disabled). Reconcile against currentEvents if that ever changes.
          setConversationStore(currentStore =>
            updateStoredConversationEvents(currentStore, conversationId, () => compacted)
          );
          store.set(contextUsageAtomFamily(conversationId), undefined);
        }
      } finally {
        setCompactingConversationIds(current => current.filter(id => id !== conversationId));
      }
    },
    // Compaction is a single short gateway call; no abort wiring until it proves slow.
    // eslint-disable-next-line react-hooks/exhaustive-deps — isModelInCatalog is a component-scope helper reading modelOptions from the render closure; modelOptions is listed so the callback re-captures it when the catalog changes.
    [
      auth.token,
      isConversationStoreLoaded,
      modelOptions,
      organizationId,
      setConversationStore,
      setCompactingConversationIds,
      store,
    ]
  );

  const compactActiveConversation = useCallback(
    (): Promise<void> => compactConversation(activeConversationId, KEEP_RECENT_EXCHANGES_MANUAL),
    [activeConversationId, compactConversation]
  );

  /*
   * Gate on summarizable history (not measured usage) so the button is never enabled-but-inert and
   * still works after a reload, when in-memory usage has reset to zero.
   */
  const canCompactActive = useMemo(
    () => hasCompactableHistory(events, KEEP_RECENT_EXCHANGES_MANUAL),
    [events]
  );

  const contextDonut = useMemo(
    () => (
      <ContextDonut
        canCompact={!isRunning && !isCompacting && canCompactActive}
        contextLength={contextLength}
        onCompact={() => {
          void compactActiveConversation();
        }}
        placement="above"
        promptTokens={activePromptTokens}
        sessionCostUsd={activeSessionCostUsd}
      />
    ),
    [
      activePromptTokens,
      activeSessionCostUsd,
      canCompactActive,
      compactActiveConversation,
      contextLength,
      isCompacting,
      isRunning,
    ]
  );

  const isModelSelectDisabled = modelOptions.length === 0;
  const isThinkingSelectDisabled = thinkingOptions.length === 0;

  // The conversation's stored model is the only model a run may use, so every gateway path
  // Waits until the loaded catalog actually contains it. Never fall back to modelOptions[0].
  const isModelInCatalog = (modelId: string): boolean =>
    modelOptions.some(option => option.id === modelId);

  const canSend =
    isConversationStoreLoaded &&
    selectedModel !== undefined &&
    selectedTabId !== undefined &&
    !isCompacting;

  conversationStoreRef.current = conversationStore;
  memoriesRef.current = memories;
  workflowsRef.current = workflows;

  useEffect(() => {
    mountedRef.current = true;
    const runs = runStatesRef.current;
    const admissions = admissionControllersRef.current;
    const pendingAdmissions = pendingAdmissionsRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of admissions.values()) {
        controller.abort();
      }
      admissions.clear();
      pendingAdmissions.clear();
      for (const runState of runs.values()) {
        runState.abort.abort();
      }
      const request = store.get(workflowRunRequestAtom);
      if (request !== undefined) {
        store.set(workflowRunRequestAtom, undefined);
        const reservation = takeWorkflowLease(request);
        if (reservation !== undefined) {
          void reservation.lease.release();
        }
      }
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;

    void (async (): Promise<void> => {
      const loaded = await loadRemoteMcpStore(storage);
      if (cancelled) {
        return;
      }
      // Cached connected tools stay usable while the background refresh runs.
      store.set(remoteMcpStoreAtom, loaded);

      // Refresh enabled servers with the PLAIN global fetch (never the gateway-authed fetch — that would leak the Kilo token to a third party).
      // Sequential by necessity: each connect can write OAuth tokens, so we must reload before merging the next server's results.
      for (const server of loaded.servers.filter(candidate => candidate.enabled)) {
        // eslint-disable-next-line no-await-in-loop
        const nextServers = await connectAndPersistRemoteMcpServer({
          fetch: globalThis.fetch,
          server,
          storageArea: storage,
        });
        if (cancelled) {
          return;
        }
        if (nextServers !== undefined) {
          store.set(remoteMcpStoreAtom, { servers: nextServers });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (isLoadingTabs) {
      return;
    }

    const inspectableTabIds = new Set(inspectableTabs.map(tab => tab.id));

    for (const runState of runStatesRef.current.values()) {
      if (!inspectableTabIds.has(runState.selectedTabId)) {
        runState.abort.abort();
      }
    }
  }, [inspectableTabs, isLoadingTabs]);

  useEffect(() => {
    if (!isConversationStoreLoaded || inspectableTabs.length === 0) {
      return;
    }

    if (pendingCreateDefaultConversationId === activeConversationId) {
      return;
    }

    const nextSelectedTabId = getSelectedInspectableTabId({
      activeTabId,
      inspectableTabs,
      selectedTabId: activeConversation.selectedTabId,
    });

    if (activeConversation.selectedTabId === nextSelectedTabId) {
      return;
    }

    setConversationStore(currentStore => {
      const currentConversation = currentStore.conversations.find(
        item => item.id === activeConversationId
      );

      if (currentConversation === undefined) {
        return currentStore;
      }

      const applyTimeSelectedTabId = getSelectedInspectableTabId({
        activeTabId,
        inspectableTabs,
        selectedTabId: currentConversation.selectedTabId,
      });

      if (currentConversation.selectedTabId === applyTimeSelectedTabId) {
        return currentStore;
      }

      return updateStoredConversationSettings(currentStore, activeConversationId, {
        selectedTabId: applyTimeSelectedTabId,
      });
    });
  }, [
    activeConversation.selectedTabId,
    activeConversationId,
    activeTabId,
    inspectableTabs,
    isConversationStoreLoaded,
    pendingCreateDefaultConversationId,
    setConversationStore,
  ]);

  useEffect(() => {
    // A running turn snapshotted its model at startTurn; repairing the stored model now
    // Would make the locked control disagree with the in-flight request. Repair after.
    if (modelOptions.length === 0 || isRunning) {
      return;
    }

    if (!modelOptions.some(option => option.id === model)) {
      setConversationStore(currentStore =>
        updateStoredConversationSettings(currentStore, activeConversationId, {
          model: modelOptions[0]?.id ?? '',
        })
      );
    }
  }, [activeConversationId, isRunning, model, modelOptions, setConversationStore]);

  useEffect(() => {
    if (thinkingOptions.length === 0 || isRunning) {
      return;
    }

    if (!thinkingOptions.includes(thinkingEffort)) {
      setConversationStore(currentStore =>
        updateStoredConversationSettings(currentStore, activeConversationId, {
          thinkingEffort: thinkingOptions[0] ?? '',
        })
      );
    }
  }, [activeConversationId, isRunning, setConversationStore, thinkingEffort, thinkingOptions]);

  const appendEvents = (conversationId: string, nextEvents: AgentConversationEvent[]): void => {
    setConversationStore(currentStore =>
      updateStoredConversationEvents(currentStore, conversationId, currentEvents => [
        ...currentEvents,
        ...nextEvents,
      ])
    );
  };

  const updateAssistantMessage = (conversationId: string, eventId: string, text: string): void => {
    setConversationStore(currentStore =>
      updateStoredConversationEvents(currentStore, conversationId, currentEvents =>
        currentEvents.map(event =>
          event.id === eventId && event.type === 'message' && event.role === 'assistant'
            ? { ...event, text }
            : event
        )
      )
    );
  };

  const updateThinkingBlock = (conversationId: string, eventId: string, text: string): void => {
    setConversationStore(currentStore =>
      updateStoredConversationEvents(currentStore, conversationId, currentEvents =>
        currentEvents.map(event =>
          event.id === eventId && event.type === 'thinking' ? { ...event, text } : event
        )
      )
    );
  };

  const updateActiveConversationSettings = (
    settings: Parameters<typeof updateStoredConversationSettings>[2]
  ): void => {
    if (!isConversationStoreLoaded) {
      return;
    }

    conversationStoreRef.current = updateStoredConversationSettings(
      conversationStoreRef.current,
      conversationStoreRef.current.activeConversationId,
      settings
    );
    setConversationStore(currentStore =>
      updateStoredConversationSettings(currentStore, currentStore.activeConversationId, settings)
    );
  };

  interface RunState {
    readonly abort: AbortController;
    readonly lease: BrowserExecutionLease;
    readonly selectedTabId: number;
    readonly runToken: number;
    readonly isCurrentRun: () => boolean;
    readonly appendRunEvents: (events: AgentConversationEvent[]) => void;
    readonly updateRunAssistantMessage: (eventId: string, text: string) => void;
    readonly updateRunThinkingBlock: (eventId: string, text: string) => void;
    readonly updateRunUsage: (usage: TurnUsage) => void;
    readonly currentRunHasUsage: () => boolean;
  }

  const createRunState = (
    conversationId: string,
    runSelectedTabId: number,
    lease: BrowserExecutionLease
  ): RunState => {
    lease.guard();
    const abort = new AbortController();
    const runToken = (runTokenRef.current += 1);
    const isCurrentRun = (): boolean =>
      runStatesRef.current.get(conversationId)?.token === runToken;
    const appendRunEvents = (nextEvents: AgentConversationEvent[]): void => {
      if (isCurrentRun()) {
        appendEvents(conversationId, nextEvents);
      }
    };
    const updateRunAssistantMessage = (eventId: string, messageText: string): void => {
      if (isCurrentRun()) {
        updateAssistantMessage(conversationId, eventId, messageText);
      }
    };
    const updateRunThinkingBlock = (eventId: string, thinkingText: string): void => {
      if (isCurrentRun()) {
        updateThinkingBlock(conversationId, eventId, thinkingText);
      }
    };
    let hasUsage = false;
    const updateRunUsage = (usage: TurnUsage): void => {
      if (isCurrentRun()) {
        hasUsage = true;
        store.set(contextUsageAtomFamily(conversationId), { promptTokens: usage.promptTokens });
        const previousCost = store.get(sessionCostAtomFamily(conversationId));
        store.set(
          sessionCostAtomFamily(conversationId),
          addSessionCost(previousCost, usage.costUsd)
        );
      }
    };
    const currentRunHasUsage = (): boolean => hasUsage;

    runStatesRef.current.set(conversationId, {
      abort,
      selectedTabId: runSelectedTabId,
      token: runToken,
    });
    setRunningConversationIds(currentIds =>
      currentIds.includes(conversationId) ? currentIds : [...currentIds, conversationId]
    );

    return {
      abort,
      appendRunEvents,
      currentRunHasUsage,
      isCurrentRun,
      lease,
      runToken,
      selectedTabId: runSelectedTabId,
      updateRunAssistantMessage,
      updateRunThinkingBlock,
      updateRunUsage,
    };
  };

  const finishRun = async (conversationId: string, runState: RunState): Promise<void> => {
    try {
      await runState.lease.release();
    } catch {
      setAdmissionBlocker(recoveryGuidance);
    }
    if (!runState.isCurrentRun()) {
      return;
    }
    const conversation = conversationStoreRef.current.conversations.find(
      item => item.id === conversationId
    );
    const latest = store.get(contextUsageAtomFamily(conversationId))?.promptTokens ?? 0;
    const ratio = getContextRatio(
      latest,
      modelOptions.find(option => option.id === conversation?.model)?.contextLength
    );
    store.set(streamingMessageIdAtomFamily(conversationId), undefined);
    runStatesRef.current.delete(conversationId);
    setRunningConversationIds(current => current.filter(id => id !== conversationId));
    if (
      !shouldSendQueuedMessage({
        aborted: runState.abort.signal.aborted,
        queued: store.get(queuedMessageAtomFamily(conversationId)),
      })
    ) {
      store.set(queuedMessageAtomFamily(conversationId), undefined);
    }
    if (runState.currentRunHasUsage() && ratio !== undefined && ratio >= AUTO_COMPACT_RATIO) {
      void compactConversation(conversationId);
    }
  };

  const setupRunContext = async (
    conversationId: string,
    runState: RunState
  ): Promise<BrowserRunContext> => {
    const conversation = conversationStoreRef.current.conversations.find(
      item => item.id === conversationId
    );
    const selectedTab = inspectableTabsRef.current.find(tab => tab.id === runState.selectedTabId);
    if (conversation === undefined || selectedTab === undefined) {
      throw new ExecutionStoppedError('tab_lost');
    }
    const runModel = conversation.model ?? '';
    const runSelectedModel = modelOptions.find(option => option.id === runModel);
    const remoteMcpServers = store.get(remoteMcpStoreAtom).servers;
    const settings = await loadWorkflowSettings(storage);
    let allowWebMcpInSafeMode = false;
    try {
      ({ allowWebMcpInSafeMode } = await loadWebMcpSettings(storage));
    } catch {
      allowWebMcpInSafeMode = false;
    }
    return {
      abort: runState.abort,
      allowTabFallback: false,
      allowWebMcpInSafeMode,
      apiBaseUrl,
      appendEvents: runState.appendRunEvents,
      executionGuard: () => {
        if (!runState.isCurrentRun()) {
          throw new ExecutionStoppedError('run_replaced');
        }
        if (!inspectableTabsRef.current.some(tab => tab.id === runState.selectedTabId)) {
          throw new ExecutionStoppedError('tab_lost');
        }
      },
      fetch: fetchFromWindow,
      lease: runState.lease,
      mode: conversation.mode ?? defaultMode,
      model: runModel,
      onAssistantStreaming: eventId => {
        if (runState.isCurrentRun()) {
          store.set(streamingMessageIdAtomFamily(conversationId), eventId);
        }
      },
      onRemoteMcpWarning: setRemoteMcpToolWarning,
      onUsage: runState.updateRunUsage,
      organizationId,
      remoteFetch: globalThis.fetch,
      remoteMcpServers,
      requestApproval: (kind, draft) =>
        requestApproval(storage, kind, draft, runState.abort.signal),
      selectedTab,
      settings,
      storage,
      supportsImages: runSelectedModel?.supportsImages === true,
      thinkingEffort: conversation.thinkingEffort ?? runSelectedModel?.variants[0] ?? '',
      token: auth.token,
      updateAssistantMessage: runState.updateRunAssistantMessage,
      updateThinkingBlock: runState.updateRunThinkingBlock,
    };
  };

  // eslint-disable-next-line max-params -- Workflow continuation reuses the prepared context and existing run state.
  const startTurn = async (
    conversationId: string,
    conversationEvents: AgentConversationEvent[],
    runState: RunState,
    preparedContext?: BrowserRunContext
  ): Promise<void> => {
    try {
      const context = preparedContext ?? (await setupRunContext(conversationId, runState));
      captureEvent(MESSAGE_SENT_EVENT, { mode: context.mode });
      const outcome = await runBrowserTurn(context, conversationEvents);
      if (outcome.effectsUncertain) {
        setAdmissionBlocker(recoveryGuidance);
      }
    } catch (error) {
      runState.appendRunEvents([
        createAssistantMessage(
          error instanceof Error
            ? `Interrupted: ${error.message}`
            : 'Browser execution was interrupted.'
        ),
      ]);
    } finally {
      await finishRun(conversationId, runState);
    }
  };

  const getConversationSelectedTabId = (conversationId: string): number | undefined => {
    const conversation = conversationStoreRef.current.conversations.find(
      candidate => candidate.id === conversationId
    );
    return conversation === undefined
      ? undefined
      : getSelectedInspectableTabId({
          activeTabId,
          inspectableTabs: inspectableTabsRef.current,
          selectedTabId: conversation.selectedTabId,
        });
  };

  const isTabOpen = async (tabId: number | undefined): Promise<boolean> => {
    if (tabId === undefined) {
      return false;
    }
    try {
      // The tab list can lag behind a closure while admission is pending.
      await browser.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  };

  const submitMessage = (
    conversationId: string,
    text: string,
    lease: BrowserExecutionLease
  ): boolean => {
    lease.guard();
    const conversation = conversationStoreRef.current.conversations.find(
      candidate => candidate.id === conversationId
    );
    if (
      conversation === undefined ||
      store.get(runningConversationIdsAtom).includes(conversationId) ||
      store.get(compactingConversationIdsAtom).includes(conversationId) ||
      !isModelInCatalog(conversation.model ?? '')
    ) {
      return false;
    }
    const runSelectedTabId = getSelectedInspectableTabId({
      activeTabId,
      inspectableTabs: inspectableTabsRef.current,
      selectedTabId: conversation.selectedTabId,
    });
    if (runSelectedTabId === undefined) {
      setAdmissionBlocker('Pick a target tab first. Your message has not been sent.');
      return false;
    }
    const selectedTab = inspectableTabsRef.current.find(tab => tab.id === runSelectedTabId);
    const userEvent = createUserMessage(
      text,
      formatSystemEnvironment({
        memories: memoriesRef.current,
        selectedTab,
        workflows: workflowsRef.current,
      })
    );
    const runState = createRunState(conversationId, runSelectedTabId, lease);
    appendEvents(conversationId, [userEvent]);
    void startTurn(conversationId, [...conversation.events, userEvent], runState);
    return true;
  };

  const getAdmissionSignal = (conversationId: string): AbortSignal => {
    let controller = admissionControllersRef.current.get(conversationId);
    if (controller === undefined) {
      controller = new AbortController();
      admissionControllersRef.current.set(conversationId, controller);
    }
    return controller.signal;
  };
  const isAdmissionCurrent = (conversationId: string, signal: AbortSignal): boolean =>
    mountedRef.current &&
    !signal.aborted &&
    isStoredConversationOpen(conversationStoreRef.current, conversationId);
  const finishAdmission = useCallback((conversationId: string, pending: PendingAdmission): void => {
    if (pendingAdmissionsRef.current.get(conversationId) === pending) {
      pendingAdmissionsRef.current.delete(conversationId);
      if (mountedRef.current) {
        setPendingAdmissionIds([...pendingAdmissionsRef.current.keys()]);
      }
    }
  }, []);
  const cancelConversationAdmissions = useCallback(
    (conversationId: string): void => {
      admissionControllersRef.current.get(conversationId)?.abort();
      admissionControllersRef.current.delete(conversationId);
      const pending = pendingAdmissionsRef.current.get(conversationId);
      if (pending !== undefined) {
        finishAdmission(conversationId, pending);
      }
      setPendingWorkflowAdmission(current =>
        current?.conversationId === conversationId ? undefined : current
      );
      const request = store.get(workflowRunRequestAtom);
      if (request !== undefined && processingWorkflowsRef.current.get(request) === conversationId) {
        store.set(workflowRunRequestAtom, undefined);
      }
    },
    [finishAdmission, store]
  );

  useEffect(() => {
    const pending = pendingAdmissionsRef.current.get(activeConversationId);
    if (pending?.queued !== undefined && pending.queued !== activeQueuedMessage) {
      finishAdmission(activeConversationId, pending);
    }
  }, [activeConversationId, activeQueuedMessage, finishAdmission]);

  const submitDraft = async (): Promise<void> => {
    const conversationId = conversationStoreRef.current.activeConversationId;
    const rawDraft = store.get(draftAtomFamily(conversationId));
    const text = rawDraft.trim();
    if (text === '' || pendingAdmissionsRef.current.has(conversationId)) {
      return;
    }
    const submittedTabId = getConversationSelectedTabId(conversationId);
    const signal = getAdmissionSignal(conversationId);
    const pending = { signal };
    pendingAdmissionsRef.current.set(conversationId, pending);
    setPendingAdmissionIds([...pendingAdmissionsRef.current.keys()]);
    let lease: BrowserExecutionLease | undefined = undefined;
    let handedOff = false;
    try {
      const admission = await getBrowserExecutionCoordinator().acquireLocal();
      lease = admission.admitted ? admission.lease : undefined;
      const targetExists = lease !== undefined && (await isTabOpen(submittedTabId));
      if (
        !isAdmissionCurrent(conversationId, signal) ||
        pendingAdmissionsRef.current.get(conversationId) !== pending
      ) {
        return;
      }
      if (
        lease === undefined ||
        !targetExists ||
        getConversationSelectedTabId(conversationId) !== submittedTabId
      ) {
        setAdmissionBlocker(
          lease === undefined
            ? 'Your message is retained. Submit it again when browser control is available.'
            : 'The target tab changed or closed. Your message is retained. Select a target tab and submit again.'
        );
        return;
      }
      lease.guard();
      const conversation = conversationStoreRef.current.conversations.find(
        candidate => candidate.id === conversationId
      );
      if (conversation === undefined) {
        return;
      }
      const action = resolveSendAction({
        hasModel: isModelInCatalog(conversation.model ?? ''),
        hasTargetTab: submittedTabId !== undefined,
        isCompacting: store.get(compactingConversationIdsAtom).includes(conversationId),
        isRunning: store.get(runningConversationIdsAtom).includes(conversationId),
        isStoreLoaded: isConversationStoreLoaded,
        text,
      });
      if (action === 'ignore') {
        return;
      }
      if (action === 'queue') {
        store.set(queuedMessageAtomFamily(conversationId), current =>
          appendQueuedMessage(current, text)
        );
      } else {
        handedOff = submitMessage(conversationId, text, lease);
        if (!handedOff) {
          return;
        }
      }
      setAdmissionBlocker(undefined);
      if (store.get(draftAtomFamily(conversationId)) === rawDraft) {
        store.set(draftAtomFamily(conversationId), '');
      }
    } catch (error) {
      if (
        isAdmissionCurrent(conversationId, signal) &&
        pendingAdmissionsRef.current.get(conversationId) === pending
      ) {
        setAdmissionBlocker(
          error instanceof Error
            ? `${error.message} Your message is retained. Submit again explicitly.`
            : 'Browser admission stopped. Submit again.'
        );
      }
    } finally {
      finishAdmission(conversationId, pending);
      if (lease !== undefined && !handedOff) {
        await lease.release();
      }
    }
  };

  const submitQueuedMessage = async (conversationId: string): Promise<void> => {
    if (pendingAdmissionsRef.current.has(conversationId)) {
      return;
    }
    const queued = store.get(queuedMessageAtomFamily(conversationId));
    if (queued === undefined) {
      return;
    }
    const submittedTabId = getConversationSelectedTabId(conversationId);
    const signal = getAdmissionSignal(conversationId);
    const pending = { queued, signal };
    pendingAdmissionsRef.current.set(conversationId, pending);
    setPendingAdmissionIds([...pendingAdmissionsRef.current.keys()]);
    let lease: BrowserExecutionLease | undefined = undefined;
    let handedOff = false;
    try {
      const admission = await getBrowserExecutionCoordinator().acquireLocal();
      lease = admission.admitted ? admission.lease : undefined;
      const targetExists = lease !== undefined && (await isTabOpen(submittedTabId));
      if (
        !isAdmissionCurrent(conversationId, signal) ||
        pendingAdmissionsRef.current.get(conversationId) !== pending ||
        store.get(queuedMessageAtomFamily(conversationId)) !== queued
      ) {
        return;
      }
      if (
        lease === undefined ||
        !targetExists ||
        getConversationSelectedTabId(conversationId) !== submittedTabId
      ) {
        pausedQueuesRef.current.add(conversationId);
        setPausedQueueIds([...pausedQueuesRef.current]);
        setAdmissionBlocker(
          lease === undefined
            ? 'Your queued message is retained. Use Resume queued message when browser control is available.'
            : 'The target tab changed or closed. Your queued message is retained. Select a target tab and use Resume queued message.'
        );
        return;
      }
      handedOff = submitMessage(conversationId, queued, lease);
      if (handedOff) {
        store.set(queuedMessageAtomFamily(conversationId), undefined);
        pausedQueuesRef.current.delete(conversationId);
        setPausedQueueIds([...pausedQueuesRef.current]);
        setAdmissionBlocker(undefined);
      }
    } catch (error) {
      if (
        isAdmissionCurrent(conversationId, signal) &&
        pendingAdmissionsRef.current.get(conversationId) === pending
      ) {
        pausedQueuesRef.current.add(conversationId);
        setPausedQueueIds([...pausedQueuesRef.current]);
        setAdmissionBlocker(
          error instanceof Error
            ? `${error.message} Your queued message is retained. Resume explicitly.`
            : 'Browser admission stopped. Resume explicitly.'
        );
      }
    } finally {
      finishAdmission(conversationId, pending);
      if (lease !== undefined && !handedOff) {
        await lease.release();
      }
    }
  };

  const stopRun = (): void => {
    cancelConversationAdmissions(activeConversationId);
    runStatesRef.current.get(activeConversationId)?.abort.abort();
  };

  const workflowRunRequest = useAtomValue(workflowRunRequestAtom);

  useEffect(() => {
    if (workflowRunRequest === undefined) {
      setPendingWorkflowAdmission(undefined);
      return;
    }
    if (
      blockedWorkflowRef.current === workflowRunRequest ||
      processingWorkflowsRef.current.has(workflowRunRequest)
    ) {
      return;
    }
    const request = workflowRunRequest;
    const reservation = takeWorkflowLease(request);
    const conversationId = reservation?.conversationId ?? activeConversationId;
    const runSelectedTabId = getConversationSelectedTabId(conversationId);
    const signal = getAdmissionSignal(conversationId);
    processingWorkflowsRef.current.set(request, conversationId);
    setPendingWorkflowAdmission(current => ({
      conversationId,
      isResuming: current?.request === request && current.isResuming,
      request,
    }));
    void (async (): Promise<void> => {
      let lease = reservation?.lease;
      let runState: RunState | undefined = undefined;
      try {
        if (lease === undefined) {
          // Old UI callers publish only workflowId/input. Remove this admission fallback after all request writers reserve a lease.
          const admission = await getBrowserExecutionCoordinator().acquireLocal();
          lease = admission.admitted ? admission.lease : undefined;
        }
        const targetExists = lease !== undefined && (await isTabOpen(runSelectedTabId));
        if (!isAdmissionCurrent(conversationId, signal)) {
          if (store.get(workflowRunRequestAtom) === request) {
            store.set(workflowRunRequestAtom, undefined);
          }
          return;
        }
        if (store.get(workflowRunRequestAtom) !== request) {
          return;
        }
        if (lease === undefined) {
          blockedWorkflowRef.current = request;
          setAdmissionBlocker(
            'Workflow input is retained. Use Resume workflow when browser control is available.'
          );
          return;
        }
        lease.guard();
        // Admission can finish after a competing send or compaction. Recheck before consuming input.
        const conversation = conversationStoreRef.current.conversations.find(
          candidate => candidate.id === conversationId
        );
        if (
          conversation === undefined ||
          !isConversationStoreLoaded ||
          !isModelInCatalog(conversation.model ?? '') ||
          runSelectedTabId === undefined ||
          !targetExists ||
          getConversationSelectedTabId(conversationId) !== runSelectedTabId ||
          store.get(compactingConversationIdsAtom).includes(conversationId) ||
          store.get(runningConversationIdsAtom).includes(conversationId)
        ) {
          blockedWorkflowRef.current = request;
          setAdmissionBlocker(
            'Workflow input is retained. Select an available conversation, model, and target tab, then resume the workflow.'
          );
          return;
        }
        // Consume only after admission; keep the same lease through workflow and model continuation.
        store.set(workflowRunRequestAtom, undefined);
        setAdmissionBlocker(undefined);
        setPendingWorkflowAdmission(current =>
          current?.request === request ? undefined : current
        );
        runState = createRunState(conversationId, runSelectedTabId, lease);
        const selectedTab = inspectableTabsRef.current.find(tab => tab.id === runSelectedTabId);
        const workflowName =
          workflowsRef.current.find(workflow => workflow.id === request.workflowId)?.name ??
          'workflow';
        const userEvent = createUserMessage(
          `Run the workflow "${workflowName}".`,
          formatSystemEnvironment({
            memories: memoriesRef.current,
            selectedTab,
            workflows: workflowsRef.current,
          })
        );
        appendEvents(conversationId, [userEvent]);
        const context = await setupRunContext(conversationId, runState);
        const toolCall = createWorkflowToolCall({
          arguments: {
            workflowId: request.workflowId,
            ...(request.input === undefined ? {} : { input: request.input }),
          },
          name: 'run_workflow',
          tabId: runSelectedTabId,
        });
        const outcome = await runBrowserWorkflow(context, toolCall);
        runState.appendRunEvents(outcome.events);
        if (outcome.effectsUncertain) {
          setAdmissionBlocker(recoveryGuidance);
          runState.appendRunEvents([createAssistantMessage(QUARANTINE_MESSAGE)]);
          return;
        }
        if (
          outcome.status === 'interrupted' ||
          outcome.status === 'cancelled' ||
          runState.abort.signal.aborted ||
          !runState.isCurrentRun()
        ) {
          return;
        }
        await startTurn(
          conversationId,
          [...conversation.events, userEvent, ...outcome.events],
          runState,
          context
        );
      } catch (error) {
        if (
          !isAdmissionCurrent(conversationId, signal) ||
          (runState === undefined && store.get(workflowRunRequestAtom) !== request)
        ) {
          return;
        }
        if (store.get(workflowRunRequestAtom) === request) {
          blockedWorkflowRef.current = request;
        }
        setAdmissionBlocker(
          error instanceof Error
            ? `Interrupted: ${error.message}`
            : 'Workflow execution was interrupted.'
        );
      } finally {
        processingWorkflowsRef.current.delete(request);
        if (mountedRef.current) {
          setPendingWorkflowAdmission(current =>
            current?.request === request ? undefined : current
          );
        }
        if (runState !== undefined) {
          await finishRun(conversationId, runState);
        } else if (lease !== undefined) {
          await lease.release();
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Execution helpers read current refs. A blocked request resumes only through its explicit button.
  }, [
    workflowRunRequest,
    workflowResume,
    activeConversationId,
    activeTabId,
    isConversationStoreLoaded,
    modelOptions,
    store,
  ]);

  /*
   * Drain a queued message once its conversation is idle. This must be an effect, not part
   * of startTurn's finally: React batches the run's last setConversationStore calls, so
   * conversationStoreRef.current is only current after the commit, and a drain inside the
   * finally would build the next request without the turn it is answering. A conversation
   * whose stored model is not in the loaded catalog keeps waiting; the model-repair effect
   * repairs the model and re-runs this one through the modelOptions dependency.
   */
  useEffect(() => {
    if (!isConversationStoreLoaded) {
      return;
    }

    const runningIds = store.get(runningConversationIdsAtom);
    const compactingIds = store.get(compactingConversationIdsAtom);

    for (const conversation of conversationStoreRef.current.conversations) {
      const queued = store.get(queuedMessageAtomFamily(conversation.id));

      if (
        queued !== undefined &&
        !runningIds.includes(conversation.id) &&
        !compactingIds.includes(conversation.id) &&
        !pausedQueuesRef.current.has(conversation.id) &&
        isModelInCatalog(conversation.model ?? '')
      ) {
        void submitQueuedMessage(conversation.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submitMessage and isModelInCatalog are component-scope helpers reading refs for latest values; listing them would loop every render. The listed deps are the only triggers: a run or compaction ending, a catalog change, or a stored conversation update such as the model repair.
  }, [
    compactingConversationIds,
    conversationStore,
    isConversationStoreLoaded,
    modelOptions,
    runningConversationIds,
    store,
  ]);

  const createConversation = (): void => {
    if (!isConversationStoreLoaded || isCreateDefaultInFlightRef.current) {
      return;
    }

    captureEvent(CONVERSATION_CREATED_EVENT);

    const settings = {
      mode,
      model,
      thinkingEffort,
    };

    conversationStoreRef.current = createNextStoredConversation(
      conversationStoreRef.current,
      emptyDefaultConversationEvents(),
      settings
    );
    setConversationStore(conversationStoreRef.current);

    const newConversationId = conversationStoreRef.current.activeConversationId;

    isCreateDefaultInFlightRef.current = true;
    setPendingCreateDefaultConversationId(newConversationId);

    void (async (): Promise<void> => {
      try {
        const freshActiveTabId = await getActiveTabId(browser.tabs);
        const latestTabs = inspectableTabsRef.current;

        if (freshActiveTabId !== undefined && latestTabs.some(tab => tab.id === freshActiveTabId)) {
          setConversationStore(currentStore => {
            const conversation = currentStore.conversations.find(
              item => item.id === newConversationId
            );

            if (conversation === undefined || conversation.selectedTabId !== undefined) {
              return currentStore;
            }

            return updateStoredConversationSettings(currentStore, newConversationId, {
              selectedTabId: freshActiveTabId,
            });
          });
        }
      } finally {
        isCreateDefaultInFlightRef.current = false;
        setPendingCreateDefaultConversationId(current =>
          current === newConversationId ? undefined : current
        );
      }
    })();
  };

  const selectConversation = (conversationId: string): void => {
    if (!isConversationStoreLoaded) {
      return;
    }

    conversationStoreRef.current = setActiveStoredConversation(
      conversationStoreRef.current,
      conversationId
    );
    setConversationStore(conversationStoreRef.current);
  };

  const abortConversationRun = useCallback(
    (conversationId: string): void => {
      cancelConversationAdmissions(conversationId);
      runStatesRef.current.get(conversationId)?.abort.abort();
      runStatesRef.current.delete(conversationId);
      // Required: deleting run-state makes the run's later finally see isCurrentRun() === false
      // And skip cleanup; without this, close/delete mid-stream leaks a stale streaming id.
      store.set(streamingMessageIdAtomFamily(conversationId), undefined);
      // A closed, deleted or signed-out conversation can never drain its pending message.
      store.set(queuedMessageAtomFamily(conversationId), undefined);
      setRunningConversationIds(currentIds =>
        currentIds.filter(currentId => currentId !== conversationId)
      );
    },
    [cancelConversationAdmissions, setRunningConversationIds, store]
  );

  const closeConversation = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      abortConversationRun(conversationId);
      const currentStore = conversationStoreRef.current;
      const closedConversation = currentStore.conversations.find(
        conversation => conversation.id === conversationId
      );
      const wasEmpty =
        closedConversation !== undefined && isStoredConversationEmpty(closedConversation);
      const nextStore = closeStoredConversationTab(
        currentStore,
        conversationId,
        emptyDefaultConversationEvents()
      );
      conversationStoreRef.current = nextStore;
      setConversationStore(nextStore);

      // Evict outside the state updater (StrictMode may double-invoke updaters).
      // Empty closed tabs are deleted: always free their atoms, including when ensureOpen
      // Recreates a fallback with the same id so drafts do not survive onto the fresh tab.
      // Non-empty closed tabs keep drafts for History reopen.
      const idsToEvict = new Set<string>();
      if (wasEmpty) {
        idsToEvict.add(conversationId);
      }
      for (const conversation of currentStore.conversations) {
        if (!nextStore.conversations.some(next => next.id === conversation.id)) {
          idsToEvict.add(conversation.id);
        }
      }
      for (const id of idsToEvict) {
        evictConversationAtoms(id);
      }
    },
    [abortConversationRun, isConversationStoreLoaded, setConversationStore]
  );

  const deleteConversation = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      if (
        isStoredConversationOpen(conversationStore, conversationId) &&
        !globalThis.confirm('Delete this conversation and close its tab?')
      ) {
        return;
      }

      abortConversationRun(conversationId);
      setConversationStore(currentStore =>
        deleteStoredConversation(currentStore, conversationId, emptyDefaultConversationEvents())
      );
      // Free per-conversation atoms; a deleted conversation can never be reopened.
      evictConversationAtoms(conversationId);
    },
    [abortConversationRun, conversationStore, isConversationStoreLoaded, setConversationStore]
  );

  const openConversationFromHistory = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      const runningIds = store.get(runningConversationIdsAtom);
      const currentStore = conversationStoreRef.current;
      const nextStore = openStoredConversation({
        conversationId,
        isActiveConversationEmpty:
          !runningIds.includes(currentStore.activeConversationId) &&
          isStoredConversationEmpty(getActiveStoredConversation(currentStore)),
        store: currentStore,
      });
      // Opening history can drop the active empty conversation; cancel admission and free its atoms.
      for (const conversation of currentStore.conversations) {
        if (!nextStore.conversations.some(next => next.id === conversation.id)) {
          cancelConversationAdmissions(conversation.id);
          evictConversationAtoms(conversation.id);
        }
      }
      conversationStoreRef.current = nextStore;
      setConversationStore(nextStore);
    },
    [cancelConversationAdmissions, isConversationStoreLoaded, setConversationStore, store]
  );

  useEffect(() => {
    if (!isConversationStoreLoaded || !isVisible) {
      onHeaderBeforeSettingsChange?.();

      return () => {
        onHeaderBeforeSettingsChange?.();
      };
    }

    onHeaderBeforeSettingsChange?.(
      <ConversationHistoryButton
        activeConversationId={activeConversationId}
        conversations={historyConversations}
        conversationStore={conversationStore}
        onDeleteConversation={deleteConversation}
        onOpenConversation={openConversationFromHistory}
      />
    );

    return () => {
      onHeaderBeforeSettingsChange?.();
    };
  }, [
    activeConversationId,
    conversationStore,
    deleteConversation,
    historyConversations,
    isConversationStoreLoaded,
    isVisible,
    onHeaderBeforeSettingsChange,
    openConversationFromHistory,
  ]);

  // Hidden means DOM-free, not unmounted: the run state, abort controllers and conversation
  // Store live in this component, so a panel-mode change must not unmount it.
  if (!isVisible) {
    return null;
  }

  const messageAdmissionPending = pendingAdmissionIds.includes(activeConversationId);
  const workflowAdmissionPending =
    pendingWorkflowAdmission?.conversationId === activeConversationId;
  const admissionStatus =
    messageAdmissionPending || workflowAdmissionPending
      ? 'Checking browser control… Your input is retained.'
      : (execution.blockedReason ?? admissionBlocker);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationTabs
        activeConversationId={activeConversationId}
        conversations={openConversations}
        isDisabled={!isConversationStoreLoaded}
        onCloseConversation={closeConversation}
        onCreateConversation={createConversation}
        onSelectConversation={selectConversation}
      />
      <ConversationList items={groupedEvents} streamingMessageId={streamingMessageId} />

      {remoteMcpToolWarning === undefined ? null : (
        <p className="flex items-start gap-2 border-t border-status-yellow-500/30 bg-status-yellow-500/10 px-4 py-2 text-xs text-status-yellow-300">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-status-yellow-400" />
          <span className="min-w-0">{remoteMcpToolWarning}</span>
        </p>
      )}

      <p
        className={
          admissionStatus === undefined
            ? 'sr-only'
            : 'type-body border-t border-border px-4 py-2 text-status-yellow-400'
        }
        role="status"
      >
        {admissionStatus}
      </p>
      {execution.delegationUnavailableReason === undefined ? null : (
        <p className="type-label px-4 py-2 text-foreground-muted">
          {execution.delegationUnavailableReason}
        </p>
      )}
      {pausedQueueIds.includes(activeConversationId) && activeQueuedMessage !== undefined ? (
        <button
          aria-busy={messageAdmissionPending}
          className="type-label mx-4 my-2 rounded-md border border-border bg-surface-overlay p-2 text-foreground-on-secondary disabled:cursor-wait disabled:opacity-50"
          disabled={messageAdmissionPending}
          onClick={() => {
            void submitQueuedMessage(activeConversationId);
          }}
          type="button"
        >
          Resume queued message
        </button>
      ) : null}
      {workflowRunRequest !== undefined &&
      (blockedWorkflowRef.current === workflowRunRequest ||
        (pendingWorkflowAdmission?.request === workflowRunRequest &&
          pendingWorkflowAdmission.isResuming)) ? (
        <button
          aria-busy={pendingWorkflowAdmission?.request === workflowRunRequest}
          className="type-label mx-4 my-2 rounded-md border border-border bg-surface-overlay p-2 text-foreground-on-secondary disabled:cursor-wait disabled:opacity-50"
          disabled={pendingWorkflowAdmission?.request === workflowRunRequest}
          onClick={() => {
            if (processingWorkflowsRef.current.has(workflowRunRequest)) {
              return;
            }
            setPendingWorkflowAdmission({
              conversationId: activeConversationId,
              isResuming: true,
              request: workflowRunRequest,
            });
            blockedWorkflowRef.current = undefined;
            setWorkflowResume(current => current + 1);
          }}
          type="button"
        >
          Resume workflow
        </button>
      ) : null}
      <MessageComposer
        activeConversationId={activeConversationId}
        canSend={canSend && !messageAdmissionPending}
        isRunning={isRunning}
        onStop={stopRun}
        onSubmit={() => {
          void submitDraft();
        }}
      />

      <footer className="border-t border-border bg-surface-raised px-4 py-2">
        <AgentFooterControls
          auth={auth}
          contextDonut={contextDonut}
          inspectableTabs={inspectableTabs}
          isLoadingTabs={isLoadingTabs}
          isConversationStoreLoaded={isConversationStoreLoaded}
          isModelSelectDisabled={isModelSelectDisabled}
          isRunning={isRunning}
          isThinkingSelectDisabled={isThinkingSelectDisabled}
          mode={mode}
          model={model}
          modelLoadError={modelLoadError}
          modelOptions={modelOptions}
          onModeChange={nextMode => {
            updateActiveConversationSettings({ mode: nextMode });
          }}
          onModelChange={nextModel => {
            updateActiveConversationSettings({ model: nextModel });
          }}
          onRetryModels={async () => {
            await refetchModels();
          }}
          onSelectedTabChange={nextSelectedTabId => {
            updateActiveConversationSettings({ selectedTabId: nextSelectedTabId });
          }}
          onThinkingEffortChange={nextThinkingEffort => {
            updateActiveConversationSettings({ thinkingEffort: nextThinkingEffort });
          }}
          organizationId={organizationId}
          selectedTabId={selectedTabId}
          tabDebuggerError={tabDebuggerError}
          thinkingEffort={thinkingEffort}
          thinkingOptions={thinkingOptions}
        />
      </footer>
    </div>
  );
};
