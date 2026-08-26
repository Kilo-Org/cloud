import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { RowOutcome } from './rowExecutor';

export type ResultRow = {
  key: string;
  label: string;
  sublabel?: string;
};

/**
 * Per-row Succeeded / Failed / Skipped display shared by both bulk-action
 * wizards. Every wizard's rows are ultimately "one action, one outcome" —
 * one person, for both the remove wizard and the add wizard — so a single
 * label/sublabel pair is enough for either; the add wizard folds the target
 * org(s) that person was actually added to into `sublabel` (e.g.
 * "person@example.com → Acme Sales, Acme EMEA") rather than this component
 * needing an org-specific column. If a future wizard needs materially
 * different columns, render its own list instead of stretching this one.
 *
 * Renders a Fragment, not its own wrapping element — like every other step
 * component in these wizards, it relies on being rendered directly inside
 * `WizardChrome`'s flex column for its layout (padding, gap, and the row
 * list's `flex-1` fill-and-scroll behavior).
 */
export function WizardResultsList({
  rows,
  outcomes,
  isRunning,
  progress,
  onRetryFailed,
  onClose,
}: {
  rows: ResultRow[];
  outcomes: RowOutcome[];
  isRunning: boolean;
  progress: { completed: number; total: number };
  onRetryFailed: () => void;
  onClose: () => void;
}) {
  const failedCount = outcomes.filter(outcome => outcome.status === 'failed').length;
  const succeededCount = outcomes.filter(outcome => outcome.status === 'succeeded').length;
  const skippedCount = outcomes.filter(outcome => outcome.status === 'skipped').length;
  const isDone = !isRunning && progress.completed >= progress.total;

  return (
    <>
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          {isRunning
            ? `Processing ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`
            : isDone
              ? `Done: ${succeededCount} succeeded, ${failedCount} failed, ${skippedCount} skipped.`
              : `${progress.total} queued.`}
        </p>
        <Progress
          value={progress.total === 0 ? 100 : (progress.completed / progress.total) * 100}
        />
      </div>

      <ul className="divide-border flex-1 min-h-0 divide-y overflow-y-auto rounded-md border">
        {rows.map((row, index) => {
          const outcome = outcomes[index];
          return (
            <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.label}</p>
                {row.sublabel && (
                  <p className="text-muted-foreground truncate text-xs">{row.sublabel}</p>
                )}
              </div>
              <ResultBadge outcome={outcome} />
            </li>
          );
        })}
      </ul>

      <div className="flex justify-end gap-2">
        {failedCount > 0 && !isRunning && (
          <Button variant="outline" onClick={onRetryFailed}>
            Retry failed ({failedCount})
          </Button>
        )}
        <Button onClick={onClose} disabled={isRunning}>
          Done
        </Button>
      </div>
    </>
  );
}

function ResultBadge({ outcome }: { outcome: RowOutcome }) {
  switch (outcome.status) {
    case 'pending':
      return <Badge variant="outline">Queued</Badge>;
    case 'running':
      return (
        <Badge variant="secondary">
          <Loader2 className="size-3 animate-spin" /> Processing
        </Badge>
      );
    case 'succeeded':
      return (
        <Badge variant="secondary">
          <CheckCircle2 className="size-3" /> Succeeded
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" title={outcome.error}>
          <XCircle className="size-3" /> Failed: {outcome.error}
        </Badge>
      );
    case 'skipped':
      return <Badge variant="outline">Skipped: {outcome.reason}</Badge>;
  }
}
