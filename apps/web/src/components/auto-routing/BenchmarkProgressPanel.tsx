'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React from 'react';
import type {
  PaidBenchmarkCase,
  PaidBenchmarkCaseStatus,
  PaidBenchmarkProgress,
} from '@kilocode/auto-routing-contracts';
import { Pause, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  CASE_STATUS_BADGE_VARIANT,
  CASE_STATUS_LABELS,
  CASE_STATUS_ORDER,
  type BenchmarkFailureCopy,
  filterCases,
  formatBenchmarkMicrodollars,
  progressTotals,
} from './benchmark-display';

type Props = {
  progress: Exclude<PaidBenchmarkProgress, { status: 'empty' }>;
  cases: readonly PaidBenchmarkCase[];
  filter: PaidBenchmarkCaseStatus | 'all';
  onFilterChange: (filter: PaidBenchmarkCaseStatus | 'all') => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  pausePending: boolean;
  error: BenchmarkFailureCopy | null;
  onPause: () => void;
  onFreshEstimate: () => void;
  quotePending: boolean;
  onRefreshProgress: () => void;
  refreshPending: boolean;
};

const STATUS_TITLE: Record<Exclude<PaidBenchmarkProgress['status'], 'empty'>, string> = {
  preparing: 'Preparing benchmark',
  active: 'Benchmark running',
  completed: 'Benchmark complete',
  paused: 'Benchmark paused',
  failed: 'Benchmark failed',
};

/**
 * Only a reused case is guaranteed free. A case with billed model requests shows
 * the ledger amount, including a known zero. Anything else has no receipt yet, so
 * it must not claim a future charge is impossible.
 */
function caseChargeLabel(item: PaidBenchmarkCase): string {
  if (item.status === 'reused') return 'Free';
  if (item.billedModelRequests > 0 || item.chargedMicrodollars > 0) {
    return `${formatBenchmarkMicrodollars(item.chargedMicrodollars)} · ${item.billedModelRequests} billed`;
  }
  return 'No charge recorded';
}

export function BenchmarkProgressPanel({
  progress,
  cases,
  filter,
  onFilterChange,
  hasMore,
  loadingMore,
  onLoadMore,
  pausePending,
  error,
  onPause,
  onFreshEstimate,
  quotePending,
  onRefreshProgress,
  refreshPending,
}: Props) {
  const totals = progressTotals(progress);
  const visible = filterCases(cases, filter);
  const inFlight = progress.status === 'preparing' || progress.status === 'active';
  const pending = progress.pendingModelRequests ?? 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium" role="status" aria-live="polite">
            {STATUS_TITLE[progress.status]}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {totals.finished} of {totals.total} cases finished
          </p>
        </div>
        <Progress
          value={totals.percent}
          aria-label="Benchmark progress"
          aria-valuetext={`${totals.finished} of ${totals.total} cases finished`}
        />
        <p className="text-muted-foreground text-xs tabular-nums">
          Spent {formatBenchmarkMicrodollars(progress.chargedMicrodollars)} · estimated{' '}
          {formatBenchmarkMicrodollars(progress.estimateMicrodollars)} · full-cost scenario{' '}
          {formatBenchmarkMicrodollars(progress.maximumMicrodollars)}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          Billed to this pool: {progress.billedModelRequests} model{' '}
          {progress.billedModelRequests === 1 ? 'request' : 'requests'} so far
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          Kilo covered: {progress.kiloCoveredModelRequests} model{' '}
          {progress.kiloCoveredModelRequests === 1 ? 'request' : 'requests'} (
          {formatBenchmarkMicrodollars(progress.kiloCoveredMicrodollars)}) once it joined
        </p>
        {pending > 0 ? (
          <p className="text-muted-foreground text-xs tabular-nums" role="status">
            {pending} model {pending === 1 ? 'request' : 'requests'} admitted for this pool, not
            confirmed yet
          </p>
        ) : null}
      </div>

      {progress.chargedMicrodollars > progress.estimateMicrodollars ? (
        <Alert variant="warning">
          <AlertTitle>Spend is above the estimate</AlertTitle>
          <AlertDescription>
            Actual charges are {formatBenchmarkMicrodollars(progress.chargedMicrodollars)}, over the{' '}
            {formatBenchmarkMicrodollars(progress.estimateMicrodollars)} estimate. The estimate does
            not limit charges. You can pause at any time.
          </AlertDescription>
        </Alert>
      ) : null}

      {progress.status === 'failed' ? (
        <Alert variant="destructive">
          <AlertTitle>
            {progress.retryable ? 'The benchmark stopped' : 'The benchmark cannot finish'}
          </AlertTitle>
          <AlertDescription>{progress.reason}</AlertDescription>
        </Alert>
      ) : null}

      {progress.status === 'completed' ? (
        <Alert>
          <AlertTitle>Benchmark complete</AlertTitle>
          <AlertDescription>
            Charged {formatBenchmarkMicrodollars(progress.chargedMicrodollars)} for{' '}
            {totals.counts.done} new and {totals.counts.reused} reused cases. The Routing table tab
            shows the routes these measurements now serve.
            {pending > 0
              ? ` ${pending} model ${
                  pending === 1 ? 'request was' : 'requests were'
                } admitted and ${
                  pending === 1 ? 'is' : 'are'
                } not confirmed yet, so the final total may be higher.`
              : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {progress.status === 'paused' ? (
        <Alert>
          <AlertTitle>
            {progress.chargedMicrodollars > 0 ? 'Paused and billed' : 'Paused'}
          </AlertTitle>
          <AlertDescription>
            {progress.chargedMicrodollars > 0
              ? `You were charged ${formatBenchmarkMicrodollars(
                  progress.chargedMicrodollars
                )} for the model requests billed before the pause. Those charges stay.`
              : pending > 0
                ? 'No charges are confirmed yet.'
                : 'No model requests were billed before the pause.'}
            {pending > 0
              ? ` ${pending} model ${
                  pending === 1 ? 'request is' : 'requests are'
                } admitted for this pool but not confirmed yet; the total may change.`
              : null}
            {progress.reason !== null ? ` ${progress.reason}` : null} Kilo covered:{' '}
            {progress.kiloCoveredModelRequests} model{' '}
            {progress.kiloCoveredModelRequests === 1 ? 'request' : 'requests'} (
            {formatBenchmarkMicrodollars(progress.kiloCoveredMicrodollars)}) once it joined. No
            further cases will start for this request.
          </AlertDescription>
        </Alert>
      ) : null}

      {error !== null ? (
        <Alert variant="destructive">
          <AlertTitle>{error.title}</AlertTitle>
          <AlertDescription>{error.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {inFlight ? (
          <Button type="button" variant="outline" disabled={pausePending} onClick={onPause}>
            <Pause className="size-4" aria-hidden />
            {pausePending ? 'Pausing…' : 'Pause benchmark'}
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={quotePending} onClick={onFreshEstimate}>
            <RefreshCw className={quotePending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            Get a fresh estimate
          </Button>
        )}
        {pausePending ? (
          <p className="text-muted-foreground text-xs" role="status" aria-live="polite">
            Pausing — the case that is already running may finish, then billing stops.
          </p>
        ) : null}
        {pending > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={refreshPending}
            onClick={onRefreshProgress}
          >
            <RefreshCw className={refreshPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            {refreshPending ? 'Refreshing…' : 'Refresh receipts'}
          </Button>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter cases by state">
          <Button
            type="button"
            size="sm"
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            aria-pressed={filter === 'all'}
            onClick={() => onFilterChange('all')}
          >
            All {totals.total}
          </Button>
          {CASE_STATUS_ORDER.map(status => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={filter === status ? 'secondary' : 'ghost'}
              aria-pressed={filter === status}
              onClick={() => onFilterChange(status)}
            >
              {CASE_STATUS_LABELS[status]} {totals.counts[status]}
            </Button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            {cases.length === 0
              ? 'No case runs reported yet. This list fills as the benchmark queues work.'
              : `No ${
                  filter === 'all' ? '' : `${CASE_STATUS_LABELS[filter].toLowerCase()} `
                }cases in the loaded page.`}
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {visible.map(item => (
              <li key={item.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={CASE_STATUS_BADGE_VARIANT[item.status]}>
                    {CASE_STATUS_LABELS[item.status]}
                  </Badge>
                  <span className="min-w-0 font-mono text-xs break-all">{item.model}</span>
                  {item.variant !== null ? <Badge variant="secondary">{item.variant}</Badge> : null}
                  {item.coveredByKilo ? <Badge variant="new">Kilo-covered</Badge> : null}
                  {item.kiloCoveredModelRequests > 0 ? (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {item.kiloCoveredModelRequests} covered
                    </span>
                  ) : null}
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                    {caseChargeLabel(item)}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  Case {item.caseId} · rep {item.repetition}
                  {item.reason !== null ? ` · ${item.reason}` : null}
                </p>
              </li>
            ))}
          </ul>
        )}

        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? 'Loading cases…' : 'Load more cases'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
