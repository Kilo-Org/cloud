import type { JSX } from 'react';
import type { SidePanelMode } from '@/src/shared/side-panel-mode';

const tabBaseClassName =
  'relative h-9 shrink-0 rounded-md px-3 type-label transition outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background';

const tabActiveClassName = `${tabBaseClassName} bg-surface-selected text-foreground font-medium`;
const tabInactiveClassName = `${tabBaseClassName} text-foreground-muted hover:bg-surface-hover`;

export const AgentsModeSwitch = ({
  mode,
  onModeChange,
}: {
  mode: SidePanelMode;
  onModeChange: (mode: SidePanelMode) => void;
}): JSX.Element => (
  <div
    aria-label="Panel mode"
    className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2"
    role="tablist"
  >
    <button
      aria-label="Browser"
      aria-selected={mode === 'browser'}
      className={mode === 'browser' ? tabActiveClassName : tabInactiveClassName}
      onClick={() => {
        onModeChange('browser');
      }}
      role="tab"
      type="button"
    >
      Browser
    </button>
    <button
      aria-label="Agents"
      aria-selected={mode === 'agents'}
      className={mode === 'agents' ? tabActiveClassName : tabInactiveClassName}
      onClick={() => {
        onModeChange('agents');
      }}
      role="tab"
      type="button"
    >
      Agents
    </button>
  </div>
);
