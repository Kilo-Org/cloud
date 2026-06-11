'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type StatusOverviewProps = {
  status: { open: number; fixed: number; ignored: number };
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

const statusConfig = [
  {
    key: 'open',
    label: 'Open',
    barClass: 'bg-yellow-500',
    dotClass: 'bg-yellow-400',
  },
  {
    key: 'fixed',
    label: 'Fixed',
    barClass: 'bg-green-500',
    dotClass: 'bg-green-400',
  },
  {
    key: 'ignored',
    label: 'Dismissed',
    barClass: 'bg-zinc-500',
    dotClass: 'bg-zinc-400',
  },
] as const;

export function StatusOverview({
  status,
  isLoading,
  basePath,
  extraParams = '',
}: StatusOverviewProps) {
  const total = status.open + status.fixed + status.ignored;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Finding status</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="block space-y-4" aria-live="polite">
            <span className="sr-only">Loading finding status</span>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : total === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No findings synced yet. Refresh GitHub data to check your repositories.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <span className="font-mono text-3xl font-bold tabular-nums">{total}</span>
              <span className="text-muted-foreground ml-2 text-sm">total findings</span>
            </div>
            <div className="space-y-2">
              {statusConfig.map(item => {
                const count = status[item.key];
                const percentage = Math.round((count / total) * 100);
                return (
                  <Link
                    key={item.key}
                    href={`${basePath}/findings?status=${item.key}${extraParams}`}
                    className="hover:bg-muted focus-visible:ring-ring group block rounded-md px-2 py-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="flex items-center justify-between gap-4 text-sm">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn('size-2 rounded-full', item.dotClass)}
                          aria-hidden="true"
                        />
                        <span>{item.label}</span>
                      </span>
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {count} ({percentage}%)
                      </span>
                    </span>
                    <span className="bg-muted mt-2 block h-1.5 overflow-hidden rounded-full">
                      <span
                        className={cn('block h-full rounded-full', item.barClass)}
                        style={{ width: `${percentage}%` }}
                      />
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
