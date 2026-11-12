'use client';

import { ChevronDown } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { formatHourlyRate } from '@/lib/cloud-agent/compute-price';
import { formatSessionTotalCost } from './session-cost-breakdown';
import { computeInstanceLabel, formatComputeDuration, formatComputeRunTime } from './compute-runs';

export type SessionComputeCharges =
  inferRouterOutputs<RootRouter>['computeBilling']['sessionCharges'];

export function SessionComputeRuns({
  charges,
  idleRate,
}: {
  charges: SessionComputeCharges;
  /** The current sandbox size and rate, shown before any compute is recorded. */
  idleRate?: string;
}) {
  const total = formatSessionTotalCost(charges.amountMicrodollars / 1_000_000);
  const runCount = charges.runs.length + (charges.earlierRuns?.count ?? 0);
  if (runCount === 0) {
    return (
      <section
        aria-label="Compute"
        className="flex min-h-11 items-center gap-3 border-t pt-2 text-sm"
      >
        <span className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Compute</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {idleRate ? `${idleRate} · No usage yet` : 'No usage yet'}
        </span>
        <span className="shrink-0 font-mono tabular-nums">{total}</span>
      </section>
    );
  }

  const instances = new Set(charges.runs.map(run => run.instance));
  const [instance] = instances;
  const meta = [
    instances.size === 1 && instance ? computeInstanceLabel(instance) : null,
    runCount === 1 ? '1 run' : `${runCount} runs`,
  ]
    .filter(Boolean)
    .join(' · ');
  const now = new Date();

  return (
    <details className="group border-t pt-2">
      <summary className="focus-visible:ring-ring flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-sm text-sm focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="text-muted-foreground size-4 shrink-0 group-open:rotate-180"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">Compute</span>
          <span className="text-muted-foreground ml-2 text-xs">{meta}</span>
        </span>
        <span className="shrink-0 font-mono tabular-nums">{total}</span>
      </summary>
      <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-2 pt-1 pb-2 pl-7 text-xs">
        {charges.runs.map((run, index) => (
          <li
            key={`${run.startedAt}-${index}`}
            className="col-span-3 grid grid-cols-subgrid items-baseline"
          >
            <span className="whitespace-nowrap">{formatComputeRunTime(run, now)}</span>
            <span className="text-muted-foreground min-w-0 truncate">
              {formatComputeDuration(run.seconds)} × {formatHourlyRate(run.rateCentsPerSecond * 36)}
            </span>
            <span className="text-right font-mono tabular-nums">
              {formatSessionTotalCost(run.amountMicrodollars / 1_000_000)}
            </span>
          </li>
        ))}
        {charges.earlierRuns && (
          <li className="col-span-3 grid grid-cols-subgrid items-baseline">
            <span className="whitespace-nowrap">
              {charges.earlierRuns.count === 1
                ? '1 earlier run'
                : `${charges.earlierRuns.count} earlier runs`}
            </span>
            <span className="text-muted-foreground min-w-0 truncate">
              {formatComputeDuration(charges.earlierRuns.seconds)}
            </span>
            <span className="text-right font-mono tabular-nums">
              {formatSessionTotalCost(charges.earlierRuns.amountMicrodollars / 1_000_000)}
            </span>
          </li>
        )}
      </ul>
    </details>
  );
}
