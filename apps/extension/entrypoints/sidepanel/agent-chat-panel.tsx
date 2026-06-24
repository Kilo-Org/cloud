/* eslint-disable import/max-dependencies, max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, ReactNode } from 'react';
import {
  createAssistantMessage,
  createUserMessage,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
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
  getStoredConversationTitle,
  isStoredConversationEmpty,
  isStoredConversationOpen,
  openStoredConversation,
  setActiveStoredConversation,
  updateStoredConversationEvents,
  updateStoredConversationSettings,
  useStoredAgentConversations,
} from './agent-conversation-storage';
import type { StoredAgentConversation } from './agent-conversation-storage';
import { AgentFooterControls } from './agent-footer-controls';
import { runDangerousLlmTurn, runSafeLlmTurn } from './agent-turn-runners';
import { useTabDebugger } from './use-tab-debugger';
import { ConversationList } from './conversation-list';
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

const ConversationTabs = ({
  activeConversationId,
  conversations,
  isDisabled,
  onCloseConversation,
  onCreateConversation,
  onSelectConversation,
  runningConversationIds,
}: {
  activeConversationId: string;
  conversations: StoredAgentConversation[];
  isDisabled: boolean;
  onCloseConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  runningConversationIds: readonly string[];
}): JSX.Element => (
  <div className="border-b border-zinc-900 bg-zinc-950">
    <div
      aria-label="Conversation tabs"
      className="agent-conversation-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-2"
      role="tablist"
    >
      {conversations.map(conversation => {
        const title = getStoredConversationTitle(conversation);
        const isActive = conversation.id === activeConversationId;
        const isRunning = runningConversationIds.includes(conversation.id);

        return (
          <div
            className={
              isActive
                ? 'flex h-8 max-w-44 shrink-0 items-center rounded-md border border-[#EDFF00]/70 bg-zinc-900 text-zinc-50'
                : 'flex h-8 max-w-44 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100'
            }
            key={conversation.id}
          >
            <button
              aria-selected={isActive}
              className="flex h-full min-w-0 items-center gap-1.5 px-2 text-left text-xs font-medium outline-none focus:ring-2 focus:ring-[#EDFF00]/50 disabled:cursor-not-allowed disabled:text-zinc-600"
              disabled={isDisabled}
              onClick={() => {
                onSelectConversation(conversation.id);
              }}
              role="tab"
              title={title}
              type="button"
            >
              {isRunning ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 animate-pulse rounded-full bg-[#EDFF00]"
                />
              ) : null}
              <span className="truncate">{title}</span>
            </button>
            <button
              aria-label={`Close ${title}`}
              className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-zinc-500 outline-none transition hover:bg-zinc-800 hover:text-zinc-100 focus:ring-2 focus:ring-[#EDFF00]/50"
              disabled={isDisabled}
              onClick={() => {
                onCloseConversation(conversation.id);
              }}
              type="button"
            >
              <span aria-hidden="true" className="text-sm leading-none">
                x
              </span>
            </button>
          </div>
        );
      })}
      <button
        aria-label="New conversation"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 outline-none transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:ring-2 focus:ring-[#EDFF00]/50 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={isDisabled}
        onClick={onCreateConversation}
        type="button"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          +
        </span>
      </button>
    </div>
  </div>
);

export const AgentChatPanel = ({
  auth,
  onHeaderBeforeSettingsChange,
  organizationId,
}: {
  auth: StoredAuth;
  onHeaderBeforeSettingsChange?: (node?: ReactNode) => void;
  organizationId: string | undefined;
}): JSX.Element => {
  const [draft, setDraft] = useState('');
  const [conversationStore, setConversationStore, isConversationStoreLoaded] =
    useStoredAgentConversations(createDefaultConversationEvents);
  const [runningConversationIds, setRunningConversationIds] = useState<string[]>([]);
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
  const isModelSelectDisabled = modelOptions.length === 0;
  const isThinkingSelectDisabled = thinkingOptions.length === 0;
  const modelControlValue = modelOptions.length === 0 ? '' : model;
  const isSendDisabled =
    !isConversationStoreLoaded ||
    draft.trim() === '' ||
    modelControlValue === '' ||
    selectedTabId === undefined;

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

    setConversationStore(store =>
      updateStoredConversationSettings(store, activeConversationId, {
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
      setConversationStore(store =>
        updateStoredConversationSettings(store, activeConversationId, {
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
      setConversationStore(store =>
        updateStoredConversationSettings(store, activeConversationId, {
          thinkingEffort: thinkingOptions[0] ?? '',
        })
      );
    }
  }, [activeConversationId, setConversationStore, thinkingEffort, thinkingOptions]);

  const appendEvents = (conversationId: string, nextEvents: AgentConversationEvent[]): void => {
    setConversationStore(store =>
      updateStoredConversationEvents(store, conversationId, currentEvents => [
        ...currentEvents,
        ...nextEvents,
      ])
    );
  };

  const updateAssistantMessage = (conversationId: string, eventId: string, text: string): void => {
    setConversationStore(store =>
      updateStoredConversationEvents(store, conversationId, currentEvents =>
        currentEvents.map(event =>
          event.id === eventId && event.type === 'message' && event.role === 'assistant'
            ? { ...event, text }
            : event
        )
      )
    );
  };

  const updateThinkingBlock = (conversationId: string, eventId: string, text: string): void => {
    setConversationStore(store =>
      updateStoredConversationEvents(store, conversationId, currentEvents =>
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
    setConversationStore(store =>
      updateStoredConversationSettings(store, store.activeConversationId, settings)
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
        }
      }
    })();
  };

  const submitDraft = (): void => {
    const text = draft.trim();
    const conversation = getActiveStoredConversation(conversationStoreRef.current);
    const conversationModel = conversation.model ?? modelOptions[0]?.id ?? '';
    const conversationSelectedTabId = getSelectedInspectableTabId({
      inspectableTabs,
      selectedTabId: conversation.selectedTabId,
    });
    const isConversationRunning = runningConversationIds.includes(conversation.id);

    if (
      !isConversationStoreLoaded ||
      text === '' ||
      isConversationRunning ||
      conversationModel === '' ||
      conversationSelectedTabId === undefined
    ) {
      return;
    }

    setDraft('');
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

    setDraft('');
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

  const abortConversationRun = useCallback((conversationId: string): void => {
    runStatesRef.current.get(conversationId)?.abort.abort();
    runStatesRef.current.delete(conversationId);
    setRunningConversationIds(currentIds =>
      currentIds.filter(currentId => currentId !== conversationId)
    );
  }, []);

  const closeConversation = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      if (!globalThis.confirm('Close this conversation tab? It will stay in History.')) {
        return;
      }

      abortConversationRun(conversationId);
      setConversationStore(store =>
        closeStoredConversationTab(store, conversationId, createDefaultConversationEvents())
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
      setConversationStore(store =>
        deleteStoredConversation(store, conversationId, createDefaultConversationEvents())
      );
    },
    [abortConversationRun, conversationStore, isConversationStoreLoaded, setConversationStore]
  );

  const openConversationFromHistory = useCallback(
    (conversationId: string): void => {
      if (!isConversationStoreLoaded) {
        return;
      }

      setDraft('');
      setConversationStore(store =>
        openStoredConversation({
          conversationId,
          isActiveConversationEmpty:
            !runningConversationIds.includes(store.activeConversationId) &&
            isStoredConversationEmpty(getActiveStoredConversation(store)),
          store,
        })
      );
    },
    [isConversationStoreLoaded, runningConversationIds, setConversationStore]
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
        runningConversationIds={runningConversationIds}
      />
      <ConversationList items={groupedEvents} />

      <form
        className="border-t border-zinc-900 px-4 py-3"
        onSubmit={event => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <label className="sr-only" htmlFor="agent-message">
          Message agent
        </label>
        <textarea
          className="min-h-20 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
          id="agent-message"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submitDraft();
            }
          }}
          placeholder="Ask Kilo to inspect this tab..."
          value={draft}
        />
        <div className="mt-2 grid gap-2">
          <button
            className="h-9 w-full rounded-md bg-[#EDFF00] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            disabled={isRunning ? false : isSendDisabled}
            onClick={isRunning ? stopRun : undefined}
            type={isRunning ? 'button' : 'submit'}
          >
            {isRunning ? 'Stop' : 'Send message'}
          </button>
        </div>
      </form>

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-2">
        <AgentFooterControls
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
