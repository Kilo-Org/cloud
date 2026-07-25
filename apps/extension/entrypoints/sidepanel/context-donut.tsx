import { useRef } from 'react';
import type { JSX } from 'react';
import { formatContextSummary, getContextRatio, getContextTone } from '@/src/shared/context-usage';
import { formatSessionCost } from '@/src/shared/session-cost';
import { DESIGN_TOKENS } from './design-tokens';

const toneStroke: Record<'danger' | 'safe' | 'warn', string> = {
  danger: DESIGN_TOKENS.statusRed500,
  safe: DESIGN_TOKENS.statusGreen500,
  warn: DESIGN_TOKENS.statusYellow500,
};

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextDonut = ({
  canCompact,
  contextLength,
  onCompact,
  promptTokens,
  sessionCostUsd,
}: {
  canCompact: boolean;
  contextLength: number | undefined;
  onCompact: () => void;
  promptTokens: number;
  sessionCostUsd: number;
}): JSX.Element => {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const ratio = getContextRatio(promptTokens, contextLength);
  const stroke =
    ratio === undefined ? DESIGN_TOKENS.statusGray500 : toneStroke[getContextTone(ratio)];
  const dash = ratio === undefined ? 0 : ratio * CIRCUMFERENCE;
  const summary = formatContextSummary(promptTokens, contextLength);
  const label = `Context usage: ${summary}`;
  const sessionCostLabel = formatSessionCost(sessionCostUsd);

  return (
    <details className="relative shrink-0" ref={detailsRef}>
      <summary
        aria-label={label}
        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
        title={summary}
      >
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <circle
            cx="8"
            cy="8"
            fill="none"
            r={RADIUS}
            stroke={DESIGN_TOKENS.surfaceBackground}
            strokeWidth="3"
          />
          <circle
            cx="8"
            cy="8"
            fill="none"
            r={RADIUS}
            stroke={stroke}
            strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            strokeWidth="3"
            transform="rotate(-90 8 8)"
          />
        </svg>
      </summary>
      <div className="absolute bottom-10 right-0 z-20 w-56 rounded-lg border border-border bg-surface-overlay p-3 shadow-lg shadow-black/50">
        <p className="text-sm font-semibold text-foreground">Context</p>
        <p className="type-label mt-1 text-foreground-muted">{summary}</p>
        <p className="type-label mt-1 text-foreground-muted">Session cost {sessionCostLabel}</p>
        <button
          className="type-label mt-3 h-8 w-full rounded-md border border-border bg-surface-overlay px-2 text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle"
          disabled={!canCompact}
          onClick={() => {
            detailsRef.current?.removeAttribute('open');
            onCompact();
          }}
          type="button"
        >
          Compact now
        </button>
      </div>
    </details>
  );
};
