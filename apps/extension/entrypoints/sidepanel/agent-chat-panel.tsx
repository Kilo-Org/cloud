/* eslint-disable import/max-dependencies, max-lines */
import { browser, storage } from '#imports';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { getDefaultStore, useAtomValue, useSetAtom, useStore } from 'jotai';
import { AlertTriangle } from 'lucide-react';
import {
  compactingConversationIdsAtom,
  contextUsageAtomFamily,
  draftAtomFamily,
  evictConversationAtoms,
  remoteMcpStoreAtom,
  runningConversationIdsAtom,
  sessionCostAtomFamily,
  streamingMessageIdAtomFamily,
} from './agent-chat-atoms';
import {
  createAssistantMessage,
  createToolResult,
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
import { runDangerousLlmTurn, runSafeLlmTurn } from './agent-turn-runners';
import { createWorkflowToolDefinitions } from '@/src/shared/agent-llm-harness';
import { formatAgentWorkflowIndex } from '@/src/shared/agent-workflows';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';
import { loadWorkflowSettings } from '@/src/shared/agent-workflows-storage';
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
import { evalInTab, getTabUrl, navigateTab } from './agent-workflow-runtime';
import { AUTO_COMPACT_RATIO, getContextRatio } from '@/src/shared/context-usage';
import { addSessionCost } from '@/src/shared/session-cost';
import { getActiveTabId, useTabDebugger } from './use-tab-debugger';
import { ConversationList } from './conversation-list';
import { ConversationTabs } from './conversation-tabs';
import { MessageComposer } from './message-composer';
import { ConversationHistoryButton } from './conversation-history-button';
import { useGatewayModels } from './use-gateway-models';
import { loadRemoteMcpStore } from '@/src/shared/remote-mcp-storage';
import { buildRemoteMcpToolDefinitions } from '@/src/shared/remote-mcp-tools';
import { connectAndPersistRemoteMcpServer } from './remote-mcp-client';
import { toRemoteMcpToolCallEvents } from './agent-tool-call-events';
import { executeRemoteMcpToolCall } from './agent-remote-mcp-tool-runtime';
import { useAgentMemories } from './use-agent-memories';
import { useAgentWorkflows } from './use-agent-workflows';
import type { AgentMemory } from '@/src/shared/agent-memories';
import { formatAgentMemoryIndex } from '@/src/shared/agent-memories';
import { requestApproval } from './pending-approval';
import { workflowRunRequestAtom } from './workflow-settings-state';
import { activeConversationIdAtom, conversationModeAtom } from './settings-dialog-state';
import { sanitizeTabContextText, sanitizeTabContextUrl } from '@/src/shared/tab-context-sanitize';
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';

const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
const emptyDefaultConversationEvents = (): AgentConversationEvent[] => [];

interface ConversationRunState {
  readonly abort: AbortController;
  readonly selectedTabId: number;
  readonly token: number;
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
  onHeaderBeforeSettingsChange,
  organizationId,
}: {
  auth: StoredAuth;
  onHeaderBeforeSettingsChange?: (node?: ReactNode) => void;
  organizationId: string | undefined;
}): JSX.Element => {
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
  const model = activeConversation.model ?? modelOptions[0]?.id ?? '';
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
      const runModel = conversation?.model ?? modelOptions[0]?.id ?? '';

      if (conversation === undefined || runModel === '') {
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
  const modelControlValue = modelOptions.length === 0 ? '' : model;
  const canSend =
    isConversationStoreLoaded &&
    modelControlValue !== '' &&
    selectedTabId !== undefined &&
    !isCompacting;

  conversationStoreRef.current = conversationStore;
  memoriesRef.current = memories;
  workflowsRef.current = workflows;

  useEffect(
    () => () => {
      for (const runState of runStatesRef.current.values()) {
        runState.abort.abort();
      }
    },
    []
  );

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
    if (modelOptions.length === 0) {
      return;
    }

    if (!modelOptions.some(option => option.id === model)) {
      setConversationStore(currentStore =>
        updateStoredConversationSettings(currentStore, activeConversationId, {
          model: modelOptions[0]?.id ?? '',
        })
      );
    }
  }, [activeConversationId, model, modelOptions, setConversationStore]);

  useEffect(() => {
    if (thinkingOptions.length === 0) {
      return;
    }

    if (!thinkingOptions.includes(thinkingEffort)) {
      setConversationStore(currentStore =>
        updateStoredConversationSettings(currentStore, activeConversationId, {
          thinkingEffort: thinkingOptions[0] ?? '',
        })
      );
    }
  }, [activeConversationId, setConversationStore, thinkingEffort, thinkingOptions]);

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
    readonly runToken: number;
    readonly isCurrentRun: () => boolean;
    readonly appendRunEvents: (events: AgentConversationEvent[]) => void;
    readonly updateRunAssistantMessage: (eventId: string, text: string) => void;
    readonly updateRunThinkingBlock: (eventId: string, text: string) => void;
    readonly updateRunUsage: (usage: TurnUsage) => void;
    readonly currentRunHasUsage: () => boolean;
  }

  const createRunState = (conversationId: string, runSelectedTabId: number): RunState => {
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
      runToken,
      updateRunAssistantMessage,
      updateRunThinkingBlock,
      updateRunUsage,
    };
  };

  const startTurn = async (
    conversationId: string,
    conversationEventsForGateway: AgentConversationEvent[],
    runState: RunState
  ): Promise<void> => {
    const cleanupRun = (): void => {
      if (!runState.isCurrentRun()) {
        return;
      }

      store.set(streamingMessageIdAtomFamily(conversationId), undefined);
      runStatesRef.current.delete(conversationId);
      setRunningConversationIds(currentIds =>
        currentIds.filter(currentId => currentId !== conversationId)
      );
    };

    const conversation = conversationStoreRef.current.conversations.find(
      candidate => candidate.id === conversationId
    );
    if (conversation === undefined) {
      cleanupRun();
      return;
    }

    const runMode = conversation.mode ?? defaultMode;
    const runModel = conversation.model ?? modelOptions[0]?.id ?? '';
    const runSelectedModel = modelOptions.find(option => option.id === runModel);
    const runThinkingOptions = runSelectedModel?.variants ?? [];
    const runThinkingEffort = conversation.thinkingEffort ?? runThinkingOptions[0] ?? '';
    const runStateEntry = runStatesRef.current.get(conversationId);
    if (runStateEntry === undefined) {
      cleanupRun();
      return;
    }
    const runSelectedTabId = runStateEntry.selectedTabId;
    const selectedTab = inspectableTabs.find(tab => tab.id === runSelectedTabId);

    try {
      const remoteMcpServers = store.get(remoteMcpStoreAtom).servers;
      const {
        routes: remoteMcpRoutes,
        tools: remoteMcpTools,
        warning: remoteMcpWarning,
      } = buildRemoteMcpToolDefinitions({ mode: runMode, servers: remoteMcpServers });
      setRemoteMcpToolWarning(remoteMcpWarning);

      const settings = await loadWorkflowSettings(storage);
      if (!runState.isCurrentRun() || runState.abort.signal.aborted) {
        return;
      }

      const { allowWorkflowsInSafeMode } = settings;
      const workflowTools = createWorkflowToolDefinitions({
        allowWorkflows: allowWorkflowsInSafeMode,
        mode: runMode,
      });
      const runTurn = runMode === 'dangerous' ? runDangerousLlmTurn : runSafeLlmTurn;

      captureEvent(MESSAGE_SENT_EVENT, { mode: runMode });
      await runTurn({
        apiBaseUrl,
        appendEvents: runState.appendRunEvents,
        conversationEvents: conversationEventsForGateway,
        executeRemoteMcpToolCall: event =>
          executeRemoteMcpToolCall({
            event,
            fetch: globalThis.fetch,
            routes: remoteMcpRoutes,
            servers: remoteMcpServers,
            signal: runState.abort.signal,
            storageArea: storage,
          }),
        fetch: fetchFromWindow,
        maxToolRounds: maxAgentToolRounds,
        model: runModel,
        onAssistantStreaming: eventId => {
          if (runState.isCurrentRun()) {
            store.set(streamingMessageIdAtomFamily(conversationId), eventId);
          }
        },
        onUsage: runState.updateRunUsage,
        organizationId,
        remoteMcpTools,
        selectedTabId: runSelectedTabId,
        signal: runState.abort.signal,
        supportsImages: runSelectedModel?.supportsImages === true,
        thinkingEffort: runThinkingEffort,
        toRemoteMcpToolCallEvents: toolCalls =>
          toRemoteMcpToolCallEvents(toolCalls, remoteMcpRoutes),
        token: auth.token,
        updateAssistantMessage: runState.updateRunAssistantMessage,
        updateThinkingBlock: runState.updateRunThinkingBlock,
        workflowToolContext: {
          allowWorkflowsInSafeMode,
          evalInTab,
          getTabUrl,
          mode: runMode,
          navigateTab,
          requestApproval: (kind, draft) =>
            requestApproval(storage, kind, draft, runState.abort.signal),
          selectedTabId: runSelectedTabId,
          selectedTabTitle: selectedTab?.title ?? '',
          selectedTabUrl: selectedTab?.url ?? '',
          signal: runState.abort.signal,
          storage,
        },
        workflowTools,
      });
    } finally {
      if (runState.isCurrentRun()) {
        const latest = store.get(contextUsageAtomFamily(conversationId))?.promptTokens ?? 0;
        const runContextLength = modelOptions.find(option => option.id === runModel)?.contextLength;
        const ratio = getContextRatio(latest, runContextLength);

        // Clean up the run state first so compactConversation's running-conversation check passes.
        cleanupRun();

        if (runState.currentRunHasUsage() && ratio !== undefined && ratio >= AUTO_COMPACT_RATIO) {
          void compactConversation(conversationId);
        }
      }
    }
  };

  const submitMessage = (text: string): void => {
    const conversation = getActiveStoredConversation(conversationStoreRef.current);
    const conversationId = conversation.id;
    const conversationEvents = conversation.events;
    const runSelectedTabId = getSelectedInspectableTabId({
      activeTabId,
      inspectableTabs,
      selectedTabId: conversation.selectedTabId,
    });
    const selectedTab = inspectableTabs.find(tab => tab.id === runSelectedTabId);
    const userEvent = createUserMessage(
      text,
      formatSystemEnvironment({
        memories: memoriesRef.current,
        selectedTab:
          selectedTab === undefined
            ? undefined
            : { title: selectedTab.title, url: selectedTab.url },
        workflows: workflowsRef.current,
      })
    );
    const conversationWithUserMessage = [...conversationEvents, userEvent];

    appendEvents(conversationId, [userEvent]);

    if (runSelectedTabId === undefined) {
      appendEvents(conversationId, [createAssistantMessage('Pick a target tab first.')]);
      return;
    }

    const runState = createRunState(conversationId, runSelectedTabId);

    void startTurn(conversationId, conversationWithUserMessage, runState);
  };

  const submitDraft = (): void => {
    const text = store.get(draftAtomFamily(activeConversationId)).trim();
    const conversation = getActiveStoredConversation(conversationStoreRef.current);
    const conversationModel = conversation.model ?? modelOptions[0]?.id ?? '';
    const conversationSelectedTabId = getSelectedInspectableTabId({
      activeTabId,
      inspectableTabs,
      selectedTabId: conversation.selectedTabId,
    });
    const isConversationRunning = store.get(runningConversationIdsAtom).includes(conversation.id);
    const isConversationCompacting = store
      .get(compactingConversationIdsAtom)
      .includes(conversation.id);

    if (
      !isConversationStoreLoaded ||
      text === '' ||
      isConversationRunning ||
      isConversationCompacting ||
      conversationModel === '' ||
      conversationSelectedTabId === undefined
    ) {
      return;
    }

    store.set(draftAtomFamily(activeConversationId), '');
    submitMessage(text);
  };

  const stopRun = (): void => {
    runStatesRef.current.get(activeConversationId)?.abort.abort();
  };

  const workflowRunRequest = useAtomValue(workflowRunRequestAtom);

  useEffect(() => {
    if (workflowRunRequest === undefined) {
      return;
    }
    const request = workflowRunRequest;

    void (async (): Promise<void> => {
      // Clear the request first so a re-render cannot double-fire.
      getDefaultStore().set(workflowRunRequestAtom, undefined);

      const conversation = conversationStoreRef.current.conversations.find(
        candidate => candidate.id === activeConversationId
      );
      if (conversation === undefined) {
        return;
      }
      const conversationId = conversation.id;
      const runModel = conversation.model ?? modelOptions[0]?.id ?? '';
      const runSelectedTabId = getSelectedInspectableTabId({
        activeTabId,
        inspectableTabs,
        selectedTabId: conversation.selectedTabId,
      });

      // Preflight gates match run button disabled states — fail silently.
      const isCompactingNow = store.get(compactingConversationIdsAtom).includes(conversationId);
      const isRunningNow = store.get(runningConversationIdsAtom).includes(conversationId);

      if (!isConversationStoreLoaded || runModel === '' || isCompactingNow || isRunningNow) {
        return;
      }

      if (runSelectedTabId === undefined) {
        appendEvents(conversationId, [createAssistantMessage('Pick a target tab first.')]);
        return;
      }

      const runState = createRunState(conversationId, runSelectedTabId);

      // Clean up the run state whenever the runner exits before calling startTurn.
      const cleanupUnstartedRun = (): void => {
        if (!runState.isCurrentRun()) {
          return;
        }

        runStatesRef.current.delete(conversationId);
        setRunningConversationIds(currentIds =>
          currentIds.filter(currentId => currentId !== conversationId)
        );
        store.set(streamingMessageIdAtomFamily(conversationId), undefined);
      };

      // Build user message with system environment including workflows index.
      const selectedTab = inspectableTabs.find(tab => tab.id === runSelectedTabId);
      const workflow = workflows.find(wf => wf.id === request.workflowId);
      const workflowName = workflow?.name ?? 'workflow';
      const userEvent = createUserMessage(
        `Run the workflow "${workflowName}".`,
        formatSystemEnvironment({
          memories: memoriesRef.current,
          selectedTab:
            selectedTab === undefined
              ? undefined
              : { title: selectedTab.title, url: selectedTab.url },
          workflows: workflows,
        })
      );
      appendEvents(conversationId, [userEvent]);

      if (runState.abort.signal.aborted) {
        cleanupUnstartedRun();
        return;
      }

      // Execute the workflow as a tool call and append the result.
      const toolCall = createWorkflowToolCall({
        arguments: { workflowId: request.workflowId },
        name: 'run_workflow',
        tabId: runSelectedTabId,
      });

      // eslint-disable-next-line init-declarations -- assigned in try block before any use; catch path returns.
      let result: Awaited<ReturnType<typeof executeWorkflowToolCall>>;
      try {
        const settings = await loadWorkflowSettings(storage);
        const runMode = conversation.mode ?? defaultMode;
        result = await executeWorkflowToolCall(toolCall, {
          allowWorkflowsInSafeMode: settings.allowWorkflowsInSafeMode,
          evalInTab: (tabId, code) => evalInTab(tabId, code),
          getTabUrl: tabId => getTabUrl(tabId),
          mode: runMode,
          navigateTab: (tabId, url) => navigateTab(tabId, url),
          requestApproval: (kind, draft) =>
            requestApproval(storage, kind, draft, runState.abort.signal),
          selectedTabId: runSelectedTabId,
          selectedTabTitle: selectedTab?.title ?? '',
          selectedTabUrl: selectedTab?.url ?? '',
          signal: runState.abort.signal,
          storage,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (runState.isCurrentRun()) {
          appendEvents(conversationId, [
            toolCall,
            createToolResult({
              error: errorMessage,
              ok: false,
              toolCallId: toolCall.id,
            }),
          ]);
        }
        cleanupUnstartedRun();
        return;
      }

      if (!runState.isCurrentRun()) {
        return;
      }

      const resultEvent = createToolResult({
        ok: result.ok,
        toolCallId: toolCall.id,
        ...(result.ok ? { value: result.value } : { error: result.error }),
      });
      appendEvents(conversationId, [toolCall, resultEvent]);

      if (runState.abort.signal.aborted || !runState.isCurrentRun()) {
        cleanupUnstartedRun();
        return;
      }

      const conversationEventsWithToolExchange = [
        ...conversation.events,
        userEvent,
        toolCall,
        resultEvent,
      ];
      void startTurn(conversationId, conversationEventsWithToolExchange, runState);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps — createRunState/startTurn/appendEvents are intentionally defined at component scope and use Refs for latest values; adding them as deps would cause an infinite render loop.
  }, [
    workflowRunRequest,
    activeConversationId,
    activeTabId,
    inspectableTabs,
    isConversationStoreLoaded,
    modelOptions,
    store,
    workflows,
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
      runStatesRef.current.get(conversationId)?.abort.abort();
      runStatesRef.current.delete(conversationId);
      // Required: deleting run-state makes the run's later finally see isCurrentRun() === false
      // And skip cleanup; without this, close/delete mid-stream leaks a stale streaming id.
      store.set(streamingMessageIdAtomFamily(conversationId), undefined);
      setRunningConversationIds(currentIds =>
        currentIds.filter(currentId => currentId !== conversationId)
      );
    },
    [setRunningConversationIds, store]
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
      // Opening history can drop the active empty conversation; free its atoms.
      for (const conversation of currentStore.conversations) {
        if (!nextStore.conversations.some(next => next.id === conversation.id)) {
          evictConversationAtoms(conversation.id);
        }
      }
      conversationStoreRef.current = nextStore;
      setConversationStore(nextStore);
    },
    [isConversationStoreLoaded, setConversationStore, store]
  );

  useEffect(() => {
    if (!isConversationStoreLoaded) {
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
    onHeaderBeforeSettingsChange,
    openConversationFromHistory,
  ]);

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

      <MessageComposer
        activeConversationId={activeConversationId}
        canSend={canSend}
        isRunning={isRunning}
        onStop={stopRun}
        onSubmit={submitDraft}
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
          model={modelControlValue}
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
