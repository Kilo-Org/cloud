'use client';

import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import type { CodingPlanQuotaWindow } from '@/lib/coding-plans/usage-contract';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import {
  formatCodingPlanQuotaPeriod,
  formatCodingPlanQuotaReset,
  formatCodingPlanRemainingPercent,
  getCodingPlanQuotaDepletion,
  isCodingPlanQuotaLow,
} from './coding-plan-usage-format';

export function CodingPlanUsage({
  subscriptionId,
  variant,
}: {
  subscriptionId: string;
  variant: 'compact' | 'full';
}) {
  const trpc = useTRPC();
  const usageQuery = useQuery(trpc.codingPlans.getUsage.queryOptions({ subscriptionId }));

  if (usageQuery.isLoading) {
    return <CodingPlanUsageSkeleton variant={variant} />;
  }

  if (usageQuery.isError || !usageQuery.data) {
    if (variant === 'compact') {
      return <p className="text-muted-foreground text-sm">Current quota unavailable</p>;
    }

    return (
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-5" />
            Current quota
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="warning">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>Current quota is temporarily unavailable.</span>
              <Button
                variant="outline"
                onClick={() => void usageQuery.refetch()}
                disabled={usageQuery.isFetching}
                aria-busy={usageQuery.isFetching}
              >
                {usageQuery.isFetching ? 'Retrying...' : 'Retry'}
              </Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const windows = usageQuery.data.subscription.windows;

  if (variant === 'compact') {
    return (
      <section aria-label="Current quota" className="space-y-3">
        <h4 className="text-sm font-medium">Current quota</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          {windows.map(window => (
            <CodingPlanQuotaWindowView key={window.id} window={window} compact />
          ))}
        </div>
      </section>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-5" />
          Current quota
        </CardTitle>
        <CardDescription>Provider-reported quota for this managed plan.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          {windows.map(window => (
            <CodingPlanQuotaWindowView key={window.id} window={window} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CodingPlanQuotaWindowView({
  window,
  compact = false,
}: {
  window: CodingPlanQuotaWindow;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'space-y-2' : 'border-border space-y-3 rounded-lg border p-4'}>
      <p className="text-muted-foreground text-sm">{formatCodingPlanQuotaPeriod(window.period)}</p>
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span
          className={cn(
            'font-semibold tracking-tight tabular-nums',
            compact ? 'text-xl' : 'text-2xl'
          )}
        >
          {formatCodingPlanRemainingPercent(window.remainingPercent)}
        </span>
        <span className="text-muted-foreground text-sm">remaining</span>
      </p>
      <Progress
        aria-hidden="true"
        value={getCodingPlanQuotaDepletion(window.remainingPercent)}
        className="h-2"
        indicatorClassName={
          isCodingPlanQuotaLow(window.remainingPercent) ? 'bg-destructive' : undefined
        }
      />
      <p className="text-muted-foreground text-xs">
        Resets <time dateTime={window.resetsAt}>{formatCodingPlanQuotaReset(window.resetsAt)}</time>
      </p>
    </div>
  );
}

function CodingPlanUsageSkeleton({ variant }: { variant: 'compact' | 'full' }) {
  const content = (
    <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
      {[0, 1].map(index => (
        <div key={index} className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-3 w-36" />
        </div>
      ))}
    </div>
  );

  if (variant === 'compact') {
    return (
      <div className="space-y-3">
        <span className="sr-only">Loading current quota</span>
        <Skeleton className="h-4 w-24" aria-hidden="true" />
        {content}
      </div>
    );
  }

  return (
    <Card>
      <span className="sr-only">Loading current quota</span>
      <CardHeader className="pb-4">
        <Skeleton className="h-5 w-36" aria-hidden="true" />
        <Skeleton className="h-4 w-64 max-w-full" aria-hidden="true" />
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
