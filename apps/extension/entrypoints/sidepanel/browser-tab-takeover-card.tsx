import type { JSX } from 'react';
import { answerTabTakeOver, useTabTakeOver } from './browser-tab-takeover';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const primaryButtonClass =
  'type-label h-8 rounded-md bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

/**
 * The side-panel half of tab take-over (D10): a panel call that hit an
 * agent-held tab waits for this answer, and only "Take over" lets the panel
 * claim the tab. The agent's in-flight call then ends with a retryable
 * `tab_taken` error instead of finishing against a page the panel now drives.
 */
export const BrowserTabTakeOverCard = (): JSX.Element | null => {
  const prompt = useTabTakeOver();

  if (prompt === undefined) {
    return null;
  }

  return (
    <div
      aria-label="Take over the tab"
      className="mx-4 mb-2 flex flex-col gap-2 rounded-md border border-status-yellow-500/30 bg-status-yellow-500/10 px-3 py-2"
      role="alertdialog"
    >
      <p className="type-label text-foreground">{`${prompt.sessionTitle} is using this tab — take over?`}</p>
      <div className="flex justify-end gap-2">
        <button
          className={secondaryButtonClass}
          onClick={() => {
            answerTabTakeOver(prompt.requestId, false);
          }}
          type="button"
        >
          Cancel
        </button>
        <button
          className={primaryButtonClass}
          onClick={() => {
            answerTabTakeOver(prompt.requestId, true);
          }}
          type="button"
        >
          Take over
        </button>
      </div>
    </div>
  );
};
