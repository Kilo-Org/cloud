'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React from 'react';
import type { PaidBenchmarkQuote } from '@kilocode/auto-routing-contracts';
import { Play, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  type BenchmarkFailureCopy,
  formatBenchmarkMicrodollars,
  quoteBreakdown,
  quoteCaseCount,
} from './benchmark-display';

type Props = {
  quote: PaidBenchmarkQuote;
  failure: BenchmarkFailureCopy | null;
  startPending: boolean;
  refreshPending: boolean;
  onStart: () => void;
  onRefreshQuote: () => void;
};

/** Read-only buttons never start work; the estimate is reviewed before the click. */
export function BenchmarkQuotePanel({
  quote,
  failure,
  startPending,
  refreshPending,
  onStart,
  onRefreshQuote,
}: Props) {
  const busy = startPending || refreshPending;

  if (quote.status === 'empty') {
    return (
      <div className="space-y-4">
        {failure !== null ? <FailureAlert failure={failure} /> : null}
        <div className="bg-muted/30 space-y-2 rounded-md border border-dashed p-4" role="status">
          <p className="text-sm font-medium">Nothing to benchmark</p>
          <p className="text-muted-foreground text-sm">
            Every model in this pool already has a current measurement, or no model in it can be
            measured right now. Add a model, or get a fresh estimate later.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRefreshQuote}>
          <RefreshCw className={refreshPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
          Get a fresh estimate
        </Button>
      </div>
    );
  }

  const breakdown = quoteBreakdown(quote);
  const total = quoteCaseCount(quote);
  // An expired, mismatched, or unaffordable quote cannot be replayed.
  const canStart = failure === null || failure.retryable;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Estimated charge for this pool</p>
        <p className="text-2xl font-semibold tabular-nums">
          {formatBenchmarkMicrodollars(quote.estimateMicrodollars)}
        </p>
        <p className="text-muted-foreground text-xs">
          {total} case {total === 1 ? 'run' : 'runs'} · full-cost scenario{' '}
          {formatBenchmarkMicrodollars(quote.maximumMicrodollars)} for the slots this pool would pay
          · estimate valid until {new Date(quote.expiresAt).toLocaleString()}
        </p>
        <p className="text-muted-foreground text-xs">
          This estimate is not a limit. You can pause at any time. If no payer can pay, the case
          pauses. Charges can exceed the estimate.
        </p>
      </div>

      <dl className="divide-border divide-y rounded-md border">
        {breakdown.map(row => (
          <div
            key={row.label}
            className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
          >
            <div className="min-w-0">
              <dt className="text-sm font-medium">{row.label}</dt>
              <dd className="text-muted-foreground text-xs">{row.detail}</dd>
            </div>
            <span className="shrink-0 text-sm tabular-nums">{row.count}</span>
          </div>
        ))}
      </dl>

      <p className="text-muted-foreground text-sm">
        Each model request is billed once, to one current payer. When several payers want the same
        case at the same time, they take turns paying for that case&apos;s model requests. If Kilo
        joins a case, Kilo pays the model requests from then on and the charges already billed stay.
        A case whose result already exists at this benchmark version is reused for free.
      </p>

      {quote.aliases.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">Alias targets in this estimate</p>
          <ul className="space-y-1">
            {quote.aliases.map(alias => (
              <li key={alias.model} className="text-muted-foreground font-mono text-xs break-all">
                {alias.model} → {alias.target}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failure !== null ? <FailureAlert failure={failure} /> : null}

      <Separator />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="button" disabled={busy || !canStart} onClick={onStart}>
          <Play className="size-4" aria-hidden />
          {startPending
            ? 'Starting benchmark…'
            : `Start benchmark · estimated ${formatBenchmarkMicrodollars(quote.estimateMicrodollars)}`}
        </Button>
        <Button
          type="button"
          variant={canStart ? 'outline' : 'default'}
          size="sm"
          disabled={busy}
          onClick={onRefreshQuote}
        >
          <RefreshCw className={refreshPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
          {canStart ? 'Refresh estimate' : 'Get a new estimate'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Nothing runs until you start it. Editing the pool or moving an alias never starts or charges
        a benchmark.
      </p>
    </div>
  );
}

function FailureAlert({ failure }: { failure: BenchmarkFailureCopy }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription>{failure.description}</AlertDescription>
    </Alert>
  );
}
