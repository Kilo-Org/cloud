/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import {
  createAssistantMessage,
  createUserMessage,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent, AgentMode } from '@/src/shared/agent-conversation';
import { defaultMode } from '@/src/shared/agent-chat-placeholder';
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
  const modelLoadRequestRef = useRef(0);
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
      const requestId = (modelLoadRequestRef.current += 1);
      const isCurrentRequest = (): boolean =>
        modelLoadRequestRef.current === requestId && signal?.aborted !== true;

      setModelLoadError(undefined);
      setModelOptions([]);
      setModel('');
      setThinkingEffort('');

      try {
        const models = await fetchKiloGatewayModels({
          apiBaseUrl,
          fetch: fetchFromWindow,
          organizationId,
          ...(signal === undefined ? {} : { signal }),
          token: auth.token,
        });

        if (isCurrentRequest()) {
          setModelOptions(models);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }

        if (!isCurrentRequest()) {
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
    const selectedTab = inspectableTabs.find(tab => tab.id === selectedTabId);
    const userEvent = createUserMessage(
      text,
      selectedTab === undefined ? undefined : formatSelectedTabSystemEnvironment(selectedTab)
    );
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
            disabled={isRunning ? false : draft.trim() === '' || model === ''}
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
          isModelSelectDisabled={isModelSelectDisabled}
          isRunning={isRunning}
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
      </footer>
    </div>
  );
};
