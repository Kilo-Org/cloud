import { useMemo, useState } from 'react';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import { getDefaultAgentPanelState } from '@/src/shared/agent-chat-placeholder';
import type { AgentChatMessage, AgentPanelFooterState } from '@/src/shared/agent-chat-placeholder';

const modeOptions = [
  { label: 'Safe', value: 'safe' },
  { label: 'Dangerous', value: 'dangerous' },
] as const;

const modelOptions = ['Claude Sonnet 4', 'Claude Opus 4', 'GPT-5'] as const;
const effortOptions = ['low', 'medium', 'high'] as const;

const isThinkingEffort = (value: string): value is AgentPanelFooterState['thinkingEffort'] =>
  value === 'low' || value === 'medium' || value === 'high';

const FieldLabel = ({ children, htmlFor }: { children: string; htmlFor: string }): JSX.Element => (
  <label className="text-[11px] font-medium text-zinc-500" htmlFor={htmlFor}>
    {children}
  </label>
);

const SelectControl = ({
  children,
  id,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}): JSX.Element => (
  <div className="grid min-w-0 gap-1">
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <select
      className="h-8 min-w-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs font-medium text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
      id={id}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
        onChange(event.currentTarget.value);
      }}
      value={value}
    >
      {children}
    </select>
  </div>
);

const ModeControl = ({
  mode,
  onChange,
}: {
  mode: 'dangerous' | 'safe';
  onChange: (mode: 'dangerous' | 'safe') => void;
}): JSX.Element => (
  <div className="grid gap-1">
    <p className="text-[11px] font-medium text-zinc-500">Mode</p>
    <div className="grid grid-cols-2 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
      {modeOptions.map(option => (
        <button
          className={
            option.value === mode
              ? 'h-7 rounded-sm bg-zinc-200 px-2 text-xs font-semibold text-zinc-950'
              : 'h-7 rounded-sm px-2 text-xs font-medium text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-1 focus:ring-offset-zinc-950'
          }
          key={option.value}
          onClick={() => {
            onChange(option.value);
          }}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

const Message = ({ message }: { message: AgentChatMessage }): JSX.Element => {
  const isUser = message.role === 'user';

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'max-w-[88%] rounded-lg bg-zinc-100 px-3 py-2 text-sm leading-5 text-zinc-950'
            : 'max-w-[88%] rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm leading-5 text-zinc-200'
        }
      >
        <p>{message.body}</p>
      </div>
    </div>
  );
};

export const AgentChatPanel = (): JSX.Element => {
  const initialState = useMemo(() => getDefaultAgentPanelState(), []);
  const [draft, setDraft] = useState(initialState.draft);
  const [mode, setMode] = useState(initialState.footer.mode);
  const [model, setModel] = useState(initialState.footer.model);
  const [thinkingEffort, setThinkingEffort] = useState(initialState.footer.thinkingEffort);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Agent conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        <div className="space-y-1 border-b border-zinc-900 pb-3">
          <p className="text-sm font-semibold text-zinc-100">Agent</p>
          <p className="text-xs leading-5 text-zinc-500">
            Placeholder conversation for the selected browser tab.
          </p>
        </div>

        <div className="flex flex-1 flex-col justify-end gap-3">
          {initialState.messages.map(message => (
            <Message key={`${message.role}-${message.body}`} message={message} />
          ))}
        </div>
      </section>

      <form
        className="border-t border-zinc-900 px-4 py-3"
        onSubmit={event => {
          event.preventDefault();
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
          disabled={draft.trim() === ''}
          type="submit"
        >
          Send message
        </button>
      </form>

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-3">
        <div className="grid gap-3">
          <ModeControl mode={mode} onChange={setMode} />
          <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
            <SelectControl id="agent-model" label="Model" onChange={setModel} value={model}>
              {modelOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectControl>
            <SelectControl
              id="thinking-effort"
              label="Thinking"
              onChange={value => {
                if (isThinkingEffort(value)) {
                  setThinkingEffort(value);
                }
              }}
              value={thinkingEffort}
            >
              {effortOptions.map(option => (
                <option key={option} value={option}>
                  {option[0]?.toUpperCase()}
                  {option.slice(1)}
                </option>
              ))}
            </SelectControl>
          </div>
        </div>
      </footer>
    </div>
  );
};
