'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/admin-utils';

type CancellationReason = {
  reason: string;
  count: number;
  firstOccurrence: string;
  lastOccurrence: string;
};

const REASON_COLORS: Record<string, string> = {
  'Superseded by new commit': 'bg-blue-500',
  'Stream timeout': 'bg-orange-500',
  'Explicitly cancelled': 'bg-slate-500',
  'Process killed': 'bg-red-500',
  'User interrupted': 'bg-purple-500',
  'No reason provided': 'bg-gray-400',
  Other: 'bg-gray-500',
};

export function CodeReviewCancellationAnalysis({ data }: { data: CancellationReason[] }) {
  const totalCancelled = data.reduce((sum, r) => sum + r.count, 0);
  const maxCount = Math.max(...data.map(r => r.count), 1);

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cancellation Reasons</CardTitle>
          <CardDescription>No cancellations in selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No cancelled reviews found in this time range.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cancellation Reasons</CardTitle>
        <CardDescription>{totalCancelled.toLocaleString()} total cancellations</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.map(row => {
          const pct = totalCancelled > 0 ? (row.count / totalCancelled) * 100 : 0;
          const barWidth = (row.count / maxCount) * 100;
          const colorClass = REASON_COLORS[row.reason] ?? 'bg-gray-500';
          return (
            <div key={row.reason} className="flex items-center gap-3">
              <span className="w-52 shrink-0 truncate text-right text-xs font-medium">
                {row.reason}
              </span>
              <div className="bg-muted relative h-5 flex-1 overflow-hidden rounded">
                <div
                  className={`${colorClass} absolute inset-y-0 left-0 rounded transition-all`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <span className="text-muted-foreground w-32 shrink-0 text-right text-xs">
                {row.count.toLocaleString()} ({pct.toFixed(1)}%)
              </span>
              <span className="text-muted-foreground w-28 shrink-0 text-right text-xs">
                {formatDate(row.lastOccurrence)}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
