import { useMemo, useState } from 'react';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import {
  getDefaultAgentPanelState,
  getFooterControlDisplay,
} from '@/src/shared/agent-chat-placeholder';
import type { AgentChatMessage, AgentPanelFooterState } from '@/src/shared/agent-chat-placeholder';

const modeOptions = [
  { label: 'Safe', value: 'safe' },
  { label: 'Dangerous', value: 'dangerous' },
] as const;

const modelOptions = ['Claude Sonnet 4', 'Claude Opus 4', 'GPT-5'] as const;
const effortOptions = ['low', 'medium', 'high'] as const;

const isThinkingEffort = (value: string): value is AgentPanelFooterState['thinkingEffort'] =>
  value === 'low' || value === 'medium' || value === 'high';

const ModeIcon = ({
  className,
  icon,
  tone,
}: {
  className: string;
  icon: ReturnType<typeof getFooterControlDisplay>['modeIcon'];
  tone: ReturnType<typeof getFooterControlDisplay>['modeIconTone'];
}): JSX.Element => {
  const toneClassName = tone === 'safe' ? 'text-[#EDFF00]' : 'text-red-400';

  return (
    <svg
      aria-hidden="true"
      className={`${className} ${toneClassName}`}
      fill="none"
      viewBox="0 0 16 16"
    >
      {icon === 'shield' ? (
        <path
          d="M8 1.75 13 3.5v3.65c0 3.1-1.9 5.55-5 7.1-3.1-1.55-5-4-5-7.1V3.5l5-1.75Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      ) : (
        <path
          d="M8 2.25 14.25 13H1.75L8 2.25Zm0 3.5v3.5m0 2.25h.01"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
};

const CompactSelectControl = ({
  ariaLabel,
  children,
  className,
  onChange,
  value,
}: {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  onChange: (value: string) => void;
  value: string;
}): JSX.Element => (
  <select
    aria-label={ariaLabel}
    className={`h-8 min-w-0 rounded-md border border-zinc-800 bg-zinc-950 text-xs font-medium text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30 ${className}`}
    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
      onChange(event.currentTarget.value);
    }}
    value={value}
  >
    {children}
  </select>
);

const ModeControl = ({
  mode,
  onChange,
}: {
  mode: 'dangerous' | 'safe';
  onChange: (mode: 'dangerous' | 'safe') => void;
}): JSX.Element => {
  const display = getFooterControlDisplay({ mode, model: '', thinkingEffort: 'medium' });
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={isOpen}
        aria-label={`Mode: ${display.modeLabel}`}
        className="flex h-8 w-10 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
        onClick={() => {
          setIsOpen(current => !current);
        }}
        type="button"
      >
        <ModeIcon className="size-3.5" icon={display.modeIcon} tone={display.modeIconTone} />
      </button>

      {isOpen ? (
        <div className="absolute bottom-10 left-0 z-10 grid w-32 gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-1">
          {modeOptions.map(option => {
            const optionDisplay = getFooterControlDisplay({
              mode: option.value,
              model: '',
              thinkingEffort: 'medium',
            });

            return (
              <button
                className={
                  option.value === mode
                    ? 'flex h-8 items-center gap-2 rounded-sm bg-zinc-900 px-2 text-xs font-medium text-zinc-100'
                    : 'flex h-8 items-center gap-2 rounded-sm px-2 text-xs font-medium text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-1 focus:ring-offset-zinc-950'
                }
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                type="button"
              >
                <ModeIcon
                  className="size-3.5"
                  icon={optionDisplay.modeIcon}
                  tone={optionDisplay.modeIconTone}
                />
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

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
  const footerDisplay = getFooterControlDisplay({ mode, model, thinkingEffort });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Agent conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
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

      <footer className="border-t border-zinc-900 bg-zinc-950 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ModeControl mode={mode} onChange={setMode} />
          <CompactSelectControl
            ariaLabel="Model"
            className="flex-1 pl-2 pr-6"
            onChange={setModel}
            value={model}
          >
            {modelOptions.map(option => (
              <option key={option} value={option}>
                {
                  getFooterControlDisplay({
                    mode,
                    model: option,
                    thinkingEffort,
                  }).modelLabel
                }
              </option>
            ))}
          </CompactSelectControl>
          <CompactSelectControl
            ariaLabel="Thinking effort"
            className="w-20 pl-2 pr-6"
            onChange={value => {
              if (isThinkingEffort(value)) {
                setThinkingEffort(value);
              }
            }}
            value={thinkingEffort}
          >
            {effortOptions.map(option => (
              <option key={option} value={option}>
                {
                  getFooterControlDisplay({
                    mode,
                    model,
                    thinkingEffort: option,
                  }).thinkingLabel
                }
              </option>
            ))}
          </CompactSelectControl>
        </div>
        <p className="sr-only">
          Mode {footerDisplay.modeLabel}, model {footerDisplay.modelLabel}, thinking{' '}
          {footerDisplay.thinkingLabel}
        </p>
      </footer>
    </div>
  );
};
