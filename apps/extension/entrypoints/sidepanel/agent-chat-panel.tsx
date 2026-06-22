import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import {
  createAssistantMessage,
  createUserMessage,
  groupConversationEvents,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  getDefaultAgentPanelState,
  getFooterControlDisplay,
} from '@/src/shared/agent-chat-placeholder';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import { fetchKiloGatewayModels } from '@/src/shared/kilo-api-client';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { AgentConversationItemView } from './agent-conversation-events';
import { AgentFooterControls } from './agent-footer-controls';
import { runDangerousLlmTurn } from './agent-llm-turn-runner';
import { useTabDebugger } from './use-tab-debugger';

const effortOptions = ['low', 'medium', 'high'] as const;
const defaultThinkingOption = 'default';
const fallbackDefaultModelId = 'Claude Sonnet 4';
const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);

const fallbackModelOptions: KiloGatewayModelOption[] = [
  {
    id: fallbackDefaultModelId,
    isPreferred: true,
    name: 'Claude Sonnet 4',
    variants: [...effortOptions],
  },
  {
    id: 'Claude Opus 4',
    isPreferred: true,
    name: 'Claude Opus 4',
    variants: [...effortOptions],
  },
  {
    id: 'GPT-5',
    isPreferred: true,
    name: 'GPT-5',
    variants: [...effortOptions],
  },
];

export const AgentChatPanel = ({ auth }: { auth: StoredAuth }): JSX.Element => {
  const initialState = useMemo(() => getDefaultAgentPanelState(), []);
  const [draft, setDraft] = useState(initialState.draft);
  const [events, setEvents] = useState<AgentConversationEvent[]>(() => [
    createAssistantMessage('Pick a tab, switch to dangerous mode, and ask Kilo to inspect it.'),
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState(initialState.footer.mode);
  const [model, setModel] = useState(initialState.footer.model);
  const [modelOptions, setModelOptions] = useState<KiloGatewayModelOption[]>(fallbackModelOptions);
  const [thinkingEffort, setThinkingEffort] = useState(initialState.footer.thinkingEffort);
  const { inspectableTabs, isLoadingTabs, loadInspectableTabs, selectTab, selectedTabId } =
    useTabDebugger();
  const selectedModel = useMemo(
    () => modelOptions.find(option => option.id === model),
    [model, modelOptions]
  );
  const groupedEvents = useMemo(() => groupConversationEvents(events), [events]);
  const thinkingOptions = useMemo(
    () =>
      selectedModel === undefined || selectedModel.variants.length === 0
        ? [defaultThinkingOption]
        : selectedModel.variants,
    [selectedModel]
  );
  const footerDisplay = getFooterControlDisplay({
    mode,
    model: selectedModel?.name ?? model,
    thinkingEffort,
  });
  const isThinkingSelectDisabled =
    selectedModel !== undefined && selectedModel.variants.length === 0;

  useEffect(() => {
    void loadInspectableTabs();
  }, [loadInspectableTabs]);

  useEffect(() => {
    const abort = new AbortController();

    void (async (): Promise<void> => {
      try {
        const models = await fetchKiloGatewayModels({
          apiBaseUrl,
          fetch: fetchFromWindow,
          signal: abort.signal,
          token: auth.token,
        });

        if (!abort.signal.aborted && models.length > 0) {
          setModelOptions(models);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }

        setModelOptions(fallbackModelOptions);
      }
    })();

    return () => {
      abort.abort();
    };
  }, [auth.token]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      return;
    }

    if (!modelOptions.some(option => option.id === model)) {
      setModel(modelOptions[0]?.id ?? fallbackDefaultModelId);
    }
  }, [model, modelOptions]);

  useEffect(() => {
    if (thinkingOptions.length === 0) {
      return;
    }

    if (!thinkingOptions.includes(thinkingEffort)) {
      setThinkingEffort(thinkingOptions[0] ?? defaultThinkingOption);
    }
  }, [thinkingEffort, thinkingOptions]);

  const appendEvents = (nextEvents: AgentConversationEvent[]): void => {
    setEvents(currentEvents => [...currentEvents, ...nextEvents]);
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

    setIsRunning(true);

    void (async (): Promise<void> => {
      try {
        await runDangerousLlmTurn({
          apiBaseUrl,
          appendEvents,
          conversationEvents: conversationWithUserMessage,
          fetch: fetchFromWindow,
          model,
          selectedTabId,
          token: auth.token,
        });
      } finally {
        setIsRunning(false);
      }
    })();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Agent conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        <div className="flex flex-1 flex-col justify-end gap-3">
          {groupedEvents.map(item => (
            <AgentConversationItemView
              item={item}
              key={item.type === 'event' ? item.event.id : item.toolCall.id}
            />
          ))}
        </div>
      </section>

      <form
        className="border-t border-zinc-900 px-4 py-3"
        onSubmit={event => {
          event.preventDefault();

          const text = draft.trim();
          if (text === '' || isRunning) {
            return;
          }

          setDraft('');
          submitMessage(text);
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
          placeholder="Ask Kilo to inspect this tab..."
          value={draft}
        />
        <button
          className="mt-2 h-9 w-full rounded-md bg-[#EDFF00] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          disabled={draft.trim() === '' || isRunning}
          type="submit"
        >
          {isRunning ? 'Running...' : 'Send message'}
        </button>
      </form>

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-2">
        <AgentFooterControls
          inspectableTabs={inspectableTabs}
          isLoadingTabs={isLoadingTabs}
          isThinkingSelectDisabled={isThinkingSelectDisabled}
          mode={mode}
          model={model}
          modelOptions={modelOptions}
          onModeChange={setMode}
          onModelChange={setModel}
          onSelectedTabChange={selectTab}
          onThinkingEffortChange={setThinkingEffort}
          selectedTabId={selectedTabId}
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
