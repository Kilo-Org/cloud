'use client';

import { memo, useMemo } from 'react';
import { Cron } from 'croner';
import { format } from 'date-fns';
import { Clock } from 'lucide-react';

type CronPreviewProps = {
  expression: string;
  timezone: string;
  count?: number;
};

/**
 * Shows the next N run times for a cron expression.
 * Uses croner for client-side computation — no server round-trip.
 */
export const CronPreview = memo(function CronPreview({
  expression,
  timezone,
  count = 5,
}: CronPreviewProps) {
  const runs = useMemo(() => {
    if (!expression.trim()) return [];
    try {
      const job = new Cron(expression, { timezone });
      const results: Date[] = [];
      let cursor: Date | undefined;
      for (let i = 0; i < count; i++) {
        const next = job.nextRun(cursor);
        if (!next) break;
        results.push(next);
        cursor = next;
      }
      return results;
    } catch {
      return [];
    }
  }, [expression, timezone, count]);

  if (runs.length === 0) return null;

  return (
    <div className="bg-muted/50 rounded-md border p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium">
        <Clock className="h-3 w-3" />
        Next {runs.length} runs ({timezone})
      </p>
      <ul className="space-y-0.5 text-xs">
        {runs.map((run, i) => (
          <li key={i} className="text-muted-foreground font-mono">
            {format(run, 'EEE, MMM d yyyy h:mm a')}
          </li>
        ))}
      </ul>
    </div>
  );
});
