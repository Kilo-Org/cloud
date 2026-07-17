import { AlertCircle, Check } from 'lucide-react';
import type { PreparationAttempt } from '@/lib/cloud-agent-sdk';
import { StatusSpinner } from '@/components/shared/StatusSpinner';
import {
  extractTickerLines,
  findRunningSetupCommand,
  summarizePreparationAttempt,
  type PreparationRowSummary,
} from './preparation-summary';

type PreparationRowProps = {
  attempt: PreparationAttempt;
  onOpenDetails: (attemptId: string) => void;
};

/**
 * Minimal one-line preparation status, styled to read like the surrounding
 * session status indicators. The row tracks the current step while the
 * attempt runs and collapses to a summary once it finishes; clicking it opens
 * the details drawer. While a setup command streams output, a short
 * non-interactive tail of it ticks along underneath.
 */
export function PreparationRow({ attempt, onOpenDetails }: PreparationRowProps) {
  const summary = summarizePreparationAttempt(attempt);
  const tickerLines = extractTickerLines(findRunningSetupCommand(attempt)?.outputTail);

  return (
    <button
      type="button"
      onClick={() => onOpenDetails(attempt.id)}
      className="group flex w-full cursor-pointer flex-col rounded-md text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className="text-muted-foreground group-hover:text-foreground flex w-full min-w-0 items-center gap-2 py-2 transition-colors"
        aria-live="polite"
      >
        <AttemptIcon status={attempt.status} />
        <RowLabel summary={summary} />
        {summary.kind !== 'failed' && (
          <span className="shrink-0 underline underline-offset-2 opacity-0 transition-opacity group-focus-visible:opacity-100 group-hover:opacity-100">
            View details
          </span>
        )}
      </span>
      {tickerLines.length > 0 && <OutputTicker lines={tickerLines} />}
    </button>
  );
}

function RowLabel({ summary }: { summary: PreparationRowSummary }) {
  if (summary.kind === 'starting') {
    return <span>Setting up environment…</span>;
  }
  if (summary.kind === 'phase') {
    return <span className="min-w-0 truncate">{summary.text}</span>;
  }
  if (summary.kind === 'command') {
    return (
      <>
        <span className="shrink-0">Executing</span>
        <code className="min-w-0 truncate font-mono">{summary.command}</code>
        {summary.commandIndex !== undefined && summary.commandCount !== undefined && (
          <span className="shrink-0 tabular-nums">
            ({summary.commandIndex + 1} of {summary.commandCount})
          </span>
        )}
      </>
    );
  }
  if (summary.kind === 'completed') {
    return (
      <>
        <span>Environment prepared</span>
        {summary.duration && <span className="shrink-0 tabular-nums">· {summary.duration}</span>}
      </>
    );
  }
  return (
    <>
      <span className="text-destructive shrink-0">Preparation failed</span>
      {summary.error && <span className="text-destructive min-w-0 truncate">{summary.error}</span>}
      <span className="shrink-0 underline underline-offset-2">View details</span>
    </>
  );
}

/**
 * Fading tail of live command output. Deliberately inert: not scrollable, not
 * announced (the drawer carries the accessible live log), newest line pinned
 * to the bottom while the mask fades earlier lines out.
 */
function OutputTicker({ lines }: { lines: string[] }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none mb-1.5 ml-5 flex h-[3.75rem] w-full flex-col justify-end overflow-hidden pr-5 font-mono text-[11px] leading-5 text-foreground-subtle [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
    >
      {lines.map((line, index) => (
        <span key={index} className="w-full truncate">
          {line || '\u00A0'}
        </span>
      ))}
    </span>
  );
}

function AttemptIcon({ status }: { status: PreparationAttempt['status'] }) {
  if (status === 'running') return <StatusSpinner className="h-3 w-3 shrink-0" />;
  if (status === 'completed') return <Check className="h-3 w-3 shrink-0" />;
  return <AlertCircle className="text-destructive h-3 w-3 shrink-0" />;
}
