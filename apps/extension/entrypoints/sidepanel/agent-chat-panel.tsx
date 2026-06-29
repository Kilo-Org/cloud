/* eslint-disable import/max-dependencies, max-lines */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  compactingConversationIdsAtom,
  contextUsageAtomFamily,
  draftAtomFamily,
  evictConversationAtoms,
  runningConversationIdsAtom,
} from './agent-chat-atoms';
import {
  createAssistantMessage,
  createUserMessage,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  KEEP_RECENT_EXCHANGES,
  KEEP_RECENT_EXCHANGES_MANUAL,
  compactConversationEvents,
  hasCompactableHistory,
} from '@/src/shared/agent-context-compaction';
import { defaultMode } from '@/src/shared/agent-chat-placeholder';
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
import { AUTO_COMPACT_RATIO, getContextRatio } from '@/src/shared/context-usage';
import { useTabDebugger } from './use-tab-debugger';
import { ConversationList } from './conversation-list';
import { ConversationTabs } from './conversation-tabs';
import { MessageComposer } from './message-composer';
import { ConversationHistoryButton } from './conversation-history-button';
import { useGatewayModels } from './use-gateway-models';

const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
const createDefaultConversationEvents = (): AgentConversationEvent[] => [
  createAssistantMessage('Pick a tab and ask Kilo to inspect it.'),
];
interface ConversationRunState {
  readonly abort: AbortController;
  readonly selectedTabId: number;
  readonly token: number;
}

const getSelectedInspectableTabId = ({
  inspectableTabs,
  selectedTabId,
}: {
  readonly inspectableTabs: readonly { readonly id: number }[];
  readonly selectedTabId: number | undefined;
}): number | undefined => {
  if (selectedTabId !== undefined && inspectableTabs.some(tab => tab.id === selectedTabId)) {
    return selectedTabId;
  }

  return inspectableTabs[0]?.id;
};

const sanitizeTabContextText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sanitizeTabContextUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);

    parsedUrl.search = '';
    parsedUrl.hash = '';

    return parsedUrl.toString();
  } catch {
    return '[invalid URL]';
  }
};
export const formatSelectedTabSystemEnvironment = ({
  title,
  url,
}: {
  readonly title: string;
  readonly url: string;
}): string =>
  `<system_environment>\nSelected tab title: ${sanitizeTabContextText(title)}\nSelected tab URL: ${sanitizeTabContextUrl(url)}\nCurrent time: ${new Date().toISOString()}\nTimezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}\n</system_environment>`;

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
    useStoredAgentConversations(createDefaultConversationEvents);
  const runningConversationIds = useAtomValue(runningConversationIdsAtom);
  const setRunningConversationIds = useSetAtom(runningConversationIdsAtom);
  const compactingConversationIds = useAtomValue(compactingConversationIdsAtom);
  const setCompactingConversationIds = useSetAtom(compactingConversationIdsAtom);
  const conversationStoreRef = useRef(conversationStore);
  const runStatesRef = useRef(new Map<string, ConversationRunState>());
  const runTokenRef = useRef(0);
  const { inspectableTabs, isLoadingTabs, tabDebuggerError } = useTabDebugger();
  const { modelLoadError, modelOptions, refetchModels } = useGatewayModels({
    auth,
    organizationId,
  });
  const activeConversation = getActiveStoredConversation(conversationStore);
  const { events, id: activeConversationId, mode = defaultMode } = activeConversation;
  const selectedTabId = getSelectedInspectableTabId({
    inspectableTabs,
    selectedTabId: activeConversation.selectedTabId,
  });
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
  const contextLength = selectedModel?.contextLength;

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
      />
    ),
    [
      activePromptTokens,
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

  useEffect(
    () => () => {
      for (const runState of runStatesRef.current.values()) {
        runState.abort.abort();
      }
    },
    []
  );

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
    const nextSelectedTabId = getSelectedInspectableTabId({
      inspectableTabs,
      selectedTabId: activeConversation.selectedTabId,
    });

    if (activeConversation.selectedTabId === nextSelectedTabId) {
      return;
    }

    setConversationStore(currentStore =>
      updateStoredConversationSettings(currentStore, activeConversationId, {
        selectedTabId: nextSelectedTabId,
      })
    );
  }, [
    activeConversation.selectedTabId,
    activeConversationId,
    inspectableTabs,
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

  const submitMessage = (text: string): void => {
    const conversation = getActiveStoredConversation(conversationStoreRef.current);
    const conversationId = conversation.id;
    const conversationEvents = conversation.events;
    const runModel = conversation.model ?? modelOptions[0]?.id ?? '';
    const runSelectedModel = modelOptions.find(option => option.id === runModel);
    const runThinkingOptions = runSelectedModel?.variants ?? [];
    const runThinkingEffort = conversation.thinkingEffort ?? runThinkingOptions[0] ?? '';
    const runSelectedTabId = getSelectedInspectableTabId({
      inspectableTabs,
      selectedTabId: conversation.selectedTabId,
    });
    const selectedTab = inspectableTabs.find(tab => tab.id === runSelectedTabId);
    const userEvent = createUserMessage(
      text,
      selectedTab === undefined ? undefined : formatSelectedTabSystemEnvironment(selectedTab)
    );
    const conversationWithUserMessage = [...conversationEvents, userEvent];

    appendEvents(conversationId, [userEvent]);

    if (runSelectedTabId === undefined) {
      appendEvents(conversationId, [createAssistantMessage('Pick a target tab first.')]);
      return;
    }

    const runMode = conversation.mode ?? defaultMode;
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
    const updateRunUsage = (usage: { promptTokens: number }): void => {
      if (isCurrentRun()) {
        store.set(contextUsageAtomFamily(conversationId), { promptTokens: usage.promptTokens });
      }
    };

    runStatesRef.current.set(conversationId, {
      abort,
      selectedTabId: runSelectedTabId,
      token: runToken,
    });
    setRunningConversationIds(currentIds =>
      currentIds.includes(conversationId) ? currentIds : [...currentIds, conversationId]
    );

    void (async (): Promise<void> => {
      try {
        const runTurn = runMode === 'dangerous' ? runDangerousLlmTurn : runSafeLlmTurn;

        await runTurn({
          apiBaseUrl,
          appendEvents: appendRunEvents,
          conversationEvents: conversationWithUserMessage,
          fetch: fetchFromWindow,
          model: runModel,
          onUsage: updateRunUsage,
          organizationId,
          selectedTabId: runSelectedTabId,
          signal: abort.signal,
          supportsImages: runSelectedModel?.supportsImages === true,
          thinkingEffort: runThinkingEffort,
          token: auth.token,
          updateAssistantMessage: updateRunAssistantMessage,
          updateThinkingBlock: updateRunThinkingBlock,
        });
      } finally {
        if (isCurrentRun()) {
          runStatesRef.current.delete(conversationId);
          setRunningConversationIds(currentIds =>
            currentIds.filter(currentId => currentId !== conversationId)
          );

          const latest = store.get(contextUsageAtomFamily(conversationId))?.promptTokens ?? 0;
          const runContextLength = modelOptions.find(
            option => option.id === runModel
          )?.contextLength;
          const ratio = getContextRatio(latest, runContextLength);

          if (ratio !== undefined && ratio >= AUTO_COMPACT_RATIO) {
            void compactConversation(conversationId);
          }
        }
      }
    })();
  };

  const submitDraft = (): void => {
    const text = store.get(draftAtomFamily(activeConversationId)).trim();
    const conversation = getActiveStoredConversation(conversationStoreRef.current);
    const conversationModel = conversation.model ?? modelOptions[0]?.id ?? '';
    const conversationSelectedTabId = getSelectedInspectableTabId({
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

  const createConversation = (): void => {
    if (!isConversationStoreLoaded) {
      return;
    }

    const settings = {
      mode,
      model,
      ...(selectedTabId === undefined ? {} : { selectedTabId }),
      thinkingEffort,
    };

    conversationStoreRef.current = createNextStoredConversation(
      conversationStoreRef.current,
      createDefaultConversationEvents(),
      settings
    );
    setConversationStore(conversationStoreRef.current);
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
      setRunningConversationIds(currentIds =>
        currentIds.filter(currentId => currentId !== conversationId)
      );
    },
    [setRunningConversationIds]
  );

  const closeConversation = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      abortConversationRun(conversationId);
      setConversationStore(currentStore =>
        closeStoredConversationTab(currentStore, conversationId, createDefaultConversationEvents())
      );
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
        deleteStoredConversation(currentStore, conversationId, createDefaultConversationEvents())
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
      <ConversationList items={groupedEvents} />

      <MessageComposer
        activeConversationId={activeConversationId}
        canSend={canSend}
        isRunning={isRunning}
        onStop={stopRun}
        onSubmit={submitDraft}
      />

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-2">
        <AgentFooterControls
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
          selectedTabId={selectedTabId}
          tabDebuggerError={tabDebuggerError}
          thinkingEffort={thinkingEffort}
          thinkingOptions={thinkingOptions}
        />
      </footer>
    </div>
  );
};
