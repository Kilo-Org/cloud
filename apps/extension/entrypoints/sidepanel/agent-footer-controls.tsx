import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { getFooterControlDisplay } from '@/src/shared/agent-chat-placeholder';
import { thinkingEffortLabel } from '@/src/shared/kilo-api-client';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import type { InspectableTab } from '@/src/shared/tab-debugger';

const modeOptions = [
  { label: 'Safe', value: 'safe' },
  { label: 'Dangerous', value: 'dangerous' },
] as const;

type AgentMode = 'dangerous' | 'safe';

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
  disabled = false,
}: {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}): JSX.Element => (
  <select
    aria-label={ariaLabel}
    className={`h-8 min-w-0 rounded-md border border-zinc-800 bg-zinc-950 text-xs font-medium text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30 disabled:cursor-not-allowed disabled:text-zinc-600 ${className}`}
    disabled={disabled}
    onChange={event => {
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
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
}): JSX.Element => {
  const display = getFooterControlDisplay({ mode, model: '', thinkingEffort: 'medium' });
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={isOpen}
        aria-label={`${display.modeLabel} mode: ${display.modeDescription}`}
        className="flex h-8 w-10 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
        onClick={() => {
          setIsOpen(current => !current);
        }}
        title={`${display.modeLabel} mode: ${display.modeDescription}`}
        type="button"
      >
        <ModeIcon className="size-3.5" icon={display.modeIcon} tone={display.modeIconTone} />
      </button>

      {isOpen ? (
        <div className="absolute bottom-10 left-0 z-10 grid w-56 gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-1">
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
                    ? 'flex items-start gap-2 rounded-sm bg-zinc-900 px-2 py-2 text-left text-zinc-100'
                    : 'flex items-start gap-2 rounded-sm px-2 py-2 text-left text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-1 focus:ring-offset-zinc-950'
                }
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                type="button"
              >
                <ModeIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  icon={optionDisplay.modeIcon}
                  tone={optionDisplay.modeIconTone}
                />
                <span className="grid gap-0.5">
                  <span className="text-xs font-medium">{option.label}</span>
                  <span className="text-[11px] leading-4 text-zinc-500">
                    {optionDisplay.modeDescription}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

export const AgentFooterControls = ({
  inspectableTabs,
  isLoadingTabs,
  isModelSelectDisabled,
  isThinkingSelectDisabled,
  mode,
  model,
  modelOptions,
  onModeChange,
  onModelChange,
  onRefreshTabs,
  onSelectedTabChange,
  onThinkingEffortChange,
  selectedTabId,
  tabDebuggerError,
  thinkingEffort,
  thinkingOptions,
}: {
  inspectableTabs: InspectableTab[];
  isLoadingTabs: boolean;
  isModelSelectDisabled: boolean;
  isThinkingSelectDisabled: boolean;
  mode: AgentMode;
  model: string;
  modelOptions: KiloGatewayModelOption[];
  onModeChange: (mode: AgentMode) => void;
  onModelChange: (model: string) => void;
  onRefreshTabs: () => Promise<void>;
  onSelectedTabChange: (tabId: number) => void;
  onThinkingEffortChange: (thinkingEffort: string) => void;
  selectedTabId: number | undefined;
  tabDebuggerError: string | undefined;
  thinkingEffort: string;
  thinkingOptions: string[];
}): JSX.Element => (
  <div className="grid gap-2">
    <div className="flex min-w-0 items-center gap-2">
      <CompactSelectControl
        ariaLabel="Target tab"
        className="min-w-0 flex-1 pl-2 pr-6"
        disabled={isLoadingTabs || inspectableTabs.length === 0}
        onChange={value => {
          const tabId = Number(value);

          if (Number.isInteger(tabId)) {
            onSelectedTabChange(tabId);
          }
        }}
        value={selectedTabId === undefined ? '' : String(selectedTabId)}
      >
        {inspectableTabs.length === 0 ? (
          <option value="">{isLoadingTabs ? 'Loading tabs...' : 'No tabs'}</option>
        ) : (
          inspectableTabs.map(tab => (
            <option key={tab.id} value={tab.id}>
              {tab.title}
            </option>
          ))
        )}
      </CompactSelectControl>
      <button
        aria-label="Refresh tabs"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-xs font-semibold text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={isLoadingTabs}
        onClick={() => {
          void onRefreshTabs();
        }}
        title="Refresh tabs"
        type="button"
      >
        <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16">
          <path
            d="M13.25 7.75a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75v3.5h-3.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </svg>
      </button>
    </div>
    {tabDebuggerError === undefined ? null : (
      <p className="text-xs leading-4 text-red-300">{tabDebuggerError}</p>
    )}
    <div className="flex min-w-0 items-center gap-2">
      <ModeControl mode={mode} onChange={onModeChange} />
      <CompactSelectControl
        ariaLabel="Model"
        className="flex-1 pl-2 pr-6"
        disabled={isModelSelectDisabled}
        onChange={onModelChange}
        value={model}
      >
        {modelOptions.length === 0 ? (
          <option value="">Loading models...</option>
        ) : (
          modelOptions.map(option => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))
        )}
      </CompactSelectControl>
      <CompactSelectControl
        ariaLabel="Thinking effort"
        className="w-24 pl-2 pr-6"
        disabled={isThinkingSelectDisabled}
        onChange={onThinkingEffortChange}
        value={thinkingEffort}
      >
        {thinkingOptions.length === 0 ? (
          <option value="">...</option>
        ) : (
          thinkingOptions.map(option => (
            <option key={option} value={option}>
              {thinkingEffortLabel(option)}
            </option>
          ))
        )}
      </CompactSelectControl>
    </div>
  </div>
);
