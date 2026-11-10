import { AlertCircle, Check } from 'lucide-react';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import { StatusSpinner } from '@/components/shared/StatusSpinner';
import {
  extractTickerLines,
  findRunningSetupCommand,
  summarizePreparationAttempt,
  type PreparationRowSummary,
} from './preparation-summary';
import { describeFailedCommand, failedCommandRows } from './failed-commands';

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
 *
 * A failed session setup or start command is non-fatal, so its attempt can
 * still complete. Each failure gets its own row beneath the summary and opens
 * the same drawer, where the command output is stored.
 */
export function PreparationRow({ attempt, onOpenDetails }: PreparationRowProps) {
  const summary = summarizePreparationAttempt(attempt);
  const tickerLines = extractTickerLines(findRunningSetupCommand(attempt)?.outputTail);
  const failedCommands = failedCommandRows(attempt);

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => onOpenDetails(attempt.id)}
        className="group flex w-full cursor-pointer flex-col rounded-md text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className="text-muted-foreground group-hover:text-foreground flex w-full min-w-0 items-center gap-2 py-2 transition-colors"
          aria-live="polite"
        >
          <AttemptIcon status={attempt.status} summary={summary} />
          <RowLabel summary={summary} />
          {summary.kind !== 'failed' && (
            <span className="shrink-0 underline underline-offset-2 opacity-0 transition-opacity group-focus-visible:opacity-100 group-hover:opacity-100">
              View details
            </span>
          )}
        </span>
        {tickerLines.length > 0 && <OutputTicker lines={tickerLines} />}
      </button>
      {failedCommands.map(row => (
        <button
          key={row.stepId}
          type="button"
          onClick={() => onOpenDetails(row.attemptId)}
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AlertCircle className="text-status-destructive-icon h-3 w-3 shrink-0" />
          <span className="text-destructive min-w-0 truncate">{describeFailedCommand(row)}</span>
          <span className="text-muted-foreground shrink-0 underline underline-offset-2 opacity-0 transition-opacity group-focus-visible:opacity-100 group-hover:opacity-100">
            View output
          </span>
        </button>
      ))}
    </div>
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
  if (summary.kind === 'incomplete') {
    return <span className="text-status-destructive min-w-0 truncate">{summary.text}</span>;
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
      className="pointer-events-none mb-1.5 ml-5 flex h-[3.75rem] min-w-0 flex-col justify-end self-stretch overflow-hidden font-mono text-[11px] leading-5 text-foreground-subtle [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
    >
      {lines.map((line, index) => (
        <span key={index} className="w-full truncate">
          {line || '\u00A0'}
        </span>
      ))}
    </span>
  );
}

function AttemptIcon({
  status,
  summary,
}: {
  status: PreparationAttempt['status'];
  summary: PreparationRowSummary;
}) {
  if (summary.kind === 'incomplete') {
    return <AlertCircle className="text-destructive h-3 w-3 shrink-0" />;
  }
  if (status === 'running') return <StatusSpinner className="h-3 w-3 shrink-0" />;
  if (status === 'completed') return <Check className="h-3 w-3 shrink-0" />;
  return <AlertCircle className="text-destructive h-3 w-3 shrink-0" />;
}
