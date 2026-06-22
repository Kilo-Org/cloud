import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import {
  createAssistantMessage,
  createUserMessage,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent, AgentMode } from '@/src/shared/agent-conversation';
import { defaultMode, getFooterControlDisplay } from '@/src/shared/agent-chat-placeholder';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import { fetchKiloGatewayModels } from '@/src/shared/kilo-api-client';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { AgentFooterControls } from './agent-footer-controls';
import { useStoredAgentConversation } from './agent-conversation-storage';
import { runDangerousLlmTurn } from './agent-llm-turn-runner';
import { useTabDebugger } from './use-tab-debugger';
import { ConversationList } from './conversation-list';

const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
const createDefaultConversationEvents = (): AgentConversationEvent[] => [
  createAssistantMessage('Pick a tab, switch to dangerous mode, and ask Kilo to inspect it.'),
];

export const AgentChatPanel = ({
  auth,
  organizationId,
}: {
  auth: StoredAuth;
  organizationId: string | undefined;
}): JSX.Element => {
  const [draft, setDraft] = useState('');
  const [events, setEvents] = useStoredAgentConversation(createDefaultConversationEvents);
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState<AgentMode>(defaultMode);
  const [model, setModel] = useState('');
  const [modelLoadError, setModelLoadError] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<KiloGatewayModelOption[]>([]);
  const [thinkingEffort, setThinkingEffort] = useState('');
  const runAbortRef = useRef<AbortController | null>(null);
  const {
    inspectableTabs,
    isLoadingTabs,
    loadInspectableTabs,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  } = useTabDebugger();
  const selectedModel = useMemo(
    () => modelOptions.find(option => option.id === model),
    [model, modelOptions]
  );
  const groupedEvents = useMemo(() => groupConversationEvents(events), [events]);
  const thinkingOptions = useMemo(
    () => (selectedModel === undefined ? [] : selectedModel.variants),
    [selectedModel]
  );
  const footerDisplay = getFooterControlDisplay({
    mode,
    model: selectedModel?.name ?? model,
    thinkingEffort,
  });
  const isModelSelectDisabled = modelOptions.length === 0;
  const isThinkingSelectDisabled = thinkingOptions.length === 0;

  useEffect(() => {
    void loadInspectableTabs();
    return () => {
      runAbortRef.current?.abort();
    };
  }, [loadInspectableTabs]);

  const loadModels = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setModelLoadError(undefined);

      try {
        const models = await fetchKiloGatewayModels({
          apiBaseUrl,
          fetch: fetchFromWindow,
          organizationId,
          ...(signal === undefined ? {} : { signal }),
          token: auth.token,
        });

        if (signal?.aborted !== true) {
          setModelOptions(models);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }

        setModelOptions([]);
        setModelLoadError('Could not load models.');
      }
    },
    [auth.token, organizationId]
  );

  useEffect(() => {
    const abort = new AbortController();

    void loadModels(abort.signal);
    return () => {
      abort.abort();
    };
  }, [loadModels]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      if (model !== '') {
        setModel('');
      }
      return;
    }

    if (!modelOptions.some(option => option.id === model)) {
      setModel(modelOptions[0]?.id ?? '');
    }
  }, [model, modelOptions]);

  useEffect(() => {
    if (thinkingOptions.length === 0) {
      if (thinkingEffort !== '') {
        setThinkingEffort('');
      }
      return;
    }

    if (!thinkingOptions.includes(thinkingEffort)) {
      setThinkingEffort(thinkingOptions[0] ?? '');
    }
  }, [thinkingEffort, thinkingOptions]);

  const appendEvents = (nextEvents: AgentConversationEvent[]): void => {
    setEvents(currentEvents => [...currentEvents, ...nextEvents]);
  };

  const updateAssistantMessage = (eventId: string, text: string): void => {
    setEvents(currentEvents =>
      currentEvents.map(event =>
        event.id === eventId && event.type === 'message' && event.role === 'assistant'
          ? { ...event, text }
          : event
      )
    );
  };

  const submitMessage = (text: string): void => {
    const userEvent = createUserMessage(text);
    const conversationWithUserMessage = [...events, userEvent];

    appendEvents([userEvent]);

    if (selectedTabId === undefined) {
      appendEvents([createAssistantMessage('Pick a target tab first.')]);
      return;
    }

    if (mode !== 'dangerous') {
      appendEvents([
        createAssistantMessage('Switch to dangerous mode before I can run eval in a tab.'),
      ]);
      return;
    }

    if (model === '') {
      appendEvents([createAssistantMessage('Models are still loading.')]);
      return;
    }

    const abort = new AbortController();
    runAbortRef.current = abort;
    setIsRunning(true);

    void (async (): Promise<void> => {
      try {
        await runDangerousLlmTurn({
          apiBaseUrl,
          appendEvents,
          conversationEvents: conversationWithUserMessage,
          fetch: fetchFromWindow,
          model,
          organizationId,
          selectedTabId,
          signal: abort.signal,
          thinkingEffort,
          token: auth.token,
          updateAssistantMessage,
        });
      } finally {
        if (runAbortRef.current === abort) {
          runAbortRef.current = null;
        }

        setIsRunning(false);
      }
    })();
  };

  const submitDraft = (): void => {
    const text = draft.trim();

    if (text === '' || isRunning || model === '') {
      return;
    }

    setDraft('');
    submitMessage(text);
  };

  const stopRun = (): void => {
    runAbortRef.current?.abort();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            disabled={draft.trim() === '' || isRunning || model === ''}
            type="submit"
          >
            {isRunning ? 'Running...' : 'Send message'}
          </button>
          {isRunning ? (
            <button
              className="h-9 w-full rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
              onClick={stopRun}
              type="button"
            >
              Stop
            </button>
          ) : null}
        </div>
      </form>

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-2">
        <AgentFooterControls
          inspectableTabs={inspectableTabs}
          isLoadingTabs={isLoadingTabs}
          isModelSelectDisabled={isModelSelectDisabled}
          isThinkingSelectDisabled={isThinkingSelectDisabled}
          mode={mode}
          model={model}
          modelLoadError={modelLoadError}
          modelOptions={modelOptions}
          onModeChange={setMode}
          onModelChange={setModel}
          onRefreshTabs={loadInspectableTabs}
          onRetryModels={() => loadModels()}
          onSelectedTabChange={selectTab}
          onThinkingEffortChange={setThinkingEffort}
          selectedTabId={selectedTabId}
          tabDebuggerError={tabDebuggerError}
          thinkingEffort={thinkingEffort}
          thinkingOptions={thinkingOptions}
        />
        <p className="sr-only">
          Mode {footerDisplay.modeLabel}: {footerDisplay.modeDescription}, model{' '}
          {footerDisplay.modelLabel}, thinking {footerDisplay.thinkingLabel}
        </p>
      </footer>
    </div>
  );
};
