import type { JSX } from 'react';
import type { SidePanelMode } from '@/src/shared/side-panel-mode';

const tabBaseClassName =
  'relative flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 type-label transition outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background';

const tabActiveClassName = `${tabBaseClassName} bg-surface-selected text-foreground font-medium`;
const tabInactiveClassName = `${tabBaseClassName} text-foreground-muted hover:bg-surface-hover`;

// Same pill vocabulary as the session status badges, in the brand tint.
const betaBadgeClassName =
  'rounded-full bg-brand-primary/15 px-1.5 py-0.5 type-eyebrow uppercase tracking-wide text-brand-primary';

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
      aria-label="Agents beta"
      aria-selected={mode === 'agents'}
      className={mode === 'agents' ? tabActiveClassName : tabInactiveClassName}
      onClick={() => {
        onModeChange('agents');
      }}
      role="tab"
      type="button"
    >
      Agents
      <span aria-hidden="true" className={betaBadgeClassName}>
        Beta
      </span>
    </button>
  </div>
);
