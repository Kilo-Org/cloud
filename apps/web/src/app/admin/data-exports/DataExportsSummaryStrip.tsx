import React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { DataExportSummary } from './data-export-types';
import { formatAge, formatCount } from './data-export-format';

type SummaryItem = {
  key: string;
  label: string;
  hint: string;
  value: number;
  /** When true, a non-zero value signals a problem and is emphasized. */
  attention?: boolean;
  detail?: string;
};

function buildItems(summary: DataExportSummary): SummaryItem[] {
  return [
    {
      key: 'needs-attention',
      label: 'Needs attention',
      hint: 'Exports with health reasons',
      value: summary.needsAttention,
      attention: true,
    },
    {
      key: 'active',
      label: 'Active exports',
      hint: 'Queued, processing, or finalizing',
      value: summary.active,
    },
    {
      key: 'pending-dispatches',
      label: 'Pending dispatches',
      hint: 'Outbox entries due now',
      value: summary.pendingDispatches,
      detail: summary.oldestPendingAt
        ? `Oldest waiting ${formatAge(summary.oldestPendingAt, summary.asOf)}`
        : undefined,
    },
    {
      key: 'stale-leases',
      label: 'Stale leases',
      hint: 'Recovery eligible',
      value: summary.staleLeases,
      attention: true,
    },
    {
      key: 'cleanup-due',
      label: 'Cleanup due',
      hint: 'Artifacts to remove',
      value: summary.cleanupDue,
      attention: true,
    },
    {
      key: 'email-unhealthy',
      label: 'Email unhealthy',
      hint: 'Delivery retry, failure, or stranded',
      value: summary.emailUnhealthy,
      attention: true,
    },
  ];
}

const stripGridClass =
  'grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 xl:grid-cols-6';

export function DataExportsSummaryStrip({
  summary,
  isLoading,
}: {
  summary: DataExportSummary | undefined;
  isLoading: boolean;
}) {
  if (isLoading && !summary) {
    return (
      <section aria-label="Export workload summary" className={stripGridClass}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="bg-card flex flex-col gap-2 p-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </section>
    );
  }

  if (!summary) return null;

  return (
    <section aria-label="Export workload summary">
      <dl className={stripGridClass}>
        {buildItems(summary).map(item => (
          <div key={item.key} className="bg-card flex flex-col gap-0.5 p-3">
            <dt className="text-muted-foreground text-xs font-medium">{item.label}</dt>
            <dd
              className={cn(
                'text-xl font-semibold tabular-nums',
                item.attention && item.value > 0 ? 'text-destructive' : 'text-foreground'
              )}
            >
              {formatCount(item.value)}
            </dd>
            <dd className="text-muted-foreground text-xs">
              {item.hint}
              {item.detail ? ` · ${item.detail}` : ''}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
