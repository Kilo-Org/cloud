'use client';

import { adminFetch } from '@/lib/admin/admin-fetch';
import {
  BenchmarkRunCancelResponseSchema,
  PaidBenchmarkAdminListResponseSchema,
  PaidBenchmarkAdminProgressResponseSchema,
  PaidBenchmarkAdminPauseResponseSchema,
  PaidBenchmarkAdminRoutingTableResponseSchema,
  type AutoRouter,
  type PaidBenchmarkAdminPayer,
  type PaidBenchmarkAdminProgressResponse,
  type PaidBenchmarkAdminRequest,
  type PaidBenchmarkAdminRequestStatus,
  type PaidBenchmarkCaseStatus,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import React, { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, PauseCircle, Route, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';
import { parseAdminResponse } from './admin-fetch';
import { AdminTimeLabel } from './AdminTimeLabel';
import { formatRunProgress, formatTotalUsd, RoutingTableView } from './benchmark-formatting';

const REQUESTS_POLL_INTERVAL_MS = 30_000;

const CASE_STATUS_ORDER: readonly PaidBenchmarkCaseStatus[] = [
  'running',
  'queued',
  'done',
  'reused',
  'failed',
  'paused',
];

const CASE_STATUS_LABELS: Record<PaidBenchmarkCaseStatus, string> = {
  running: 'running',
  queued: 'queued',
  done: 'done',
  reused: 'reused',
  failed: 'failed',
  paused: 'paused',
};

const STATUS_BADGE_VARIANT: Record<
  PaidBenchmarkAdminRequestStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  preparing: 'secondary',
  active: 'default',
  completed: 'outline',
  paused: 'secondary',
  failed: 'destructive',
};

/** Console filter; `in_progress` is the pair of statuses that still spend. */
export type RequestsFilter = 'all' | 'in_progress' | 'paused' | 'failed' | 'completed';

export const REQUESTS_FILTER_STATUSES: Record<
  RequestsFilter,
  readonly PaidBenchmarkAdminRequestStatus[] | null
> = {
  all: null,
  in_progress: ['preparing', 'active'],
  paused: ['paused'],
  failed: ['failed'],
  completed: ['completed'],
};

/** Microdollars are millionths of a dollar; the console reads dollars like the runs list. */
export function formatMicrodollars(value: number): string {
  return formatTotalUsd(value / 1_000_000);
}

export type RequestCaseProgress = {
  total: number;
  /** Cases no longer waiting: done, reused, failed or paused. */
  settled: number;
  percent: number;
  counts: readonly { status: PaidBenchmarkCaseStatus; count: number }[];
};

export function requestCaseProgress(
  request: Pick<PaidBenchmarkAdminRequest, 'counts'>
): RequestCaseProgress {
  const counts = CASE_STATUS_ORDER.map(status => ({
    status,
    count: request.counts[status] ?? 0,
  }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const settled = counts
    .filter(entry => entry.status !== 'running' && entry.status !== 'queued')
    .reduce((sum, entry) => sum + entry.count, 0);
  return {
    total,
    settled,
    percent: total > 0 ? Math.min(100, (settled / total) * 100) : 0,
    counts,
  };
}

/** "12 / 40 cases · 3 running · 2 failed"; empty while nothing is planned. */
export function requestCaseLine(request: Pick<PaidBenchmarkAdminRequest, 'counts'>): string {
  const progress = requestCaseProgress(request);
  if (progress.total === 0) return 'No cases planned';
  const parts = progress.counts
    .filter(entry => entry.count > 0)
    .map(entry => `${entry.count} ${CASE_STATUS_LABELS[entry.status]}`);
  return `${progress.settled} / ${progress.total} cases settled · ${parts.join(' · ')}`;
}

export type PayerShare = {
  payer: PaidBenchmarkAdminPayer;
  /** Null for the platform cover and until a charge settles: the split is not final yet. */
  share: number | null;
};

export function payerShares(payers: readonly PaidBenchmarkAdminPayer[]): readonly PayerShare[] {
  // A platform row reports covered model requests without a charge, so the split is over
  // the billed shares only; showing Kilo 0% would misread coverage as a zero-cost payer.
  const total = payers
    .filter(payer => payer.kind !== 'platform')
    .reduce((sum, payer) => sum + payer.chargedMicrodollars, 0);
  return payers.map(payer => ({
    payer,
    share: payer.kind === 'platform' || total === 0 ? null : payer.chargedMicrodollars / total,
  }));
}

export function payerLabel(payer: PaidBenchmarkAdminPayer): string {
  if (payer.kind === 'platform') return 'Kilo';
  return payer.ownerLabel ?? `${payer.kind === 'org' ? 'Org' : 'User'} ${payer.ownerId}`;
}

/**
 * "alice@example.com 50% (6 requests) · Kilo covers 3 requests", with a detached payer's
 * reason attached so an admin sees why the request stopped billing them.
 */
export function payerSummary(payers: readonly PaidBenchmarkAdminPayer[]): string {
  if (payers.length === 0) return 'No assigned payer';
  const shares = payerShares(payers);
  const paid = shares.filter(entry => entry.payer.kind !== 'platform');
  const platform = shares.filter(entry => entry.payer.kind === 'platform');
  const platformText = platform.map(entry => {
    const covered = entry.payer.kind === 'platform' ? entry.payer.kiloCoveredModelRequests : 0;
    return `Kilo covers ${covered} ${covered === 1 ? 'request' : 'requests'}`;
  });
  if (paid.length === 0) return platformText.join(' · ');
  const paidText = paid.every(entry => entry.share === null)
    ? 'Spend settles on completion'
    : paid
        .map(entry => {
          if (entry.payer.kind === 'platform') return 'Kilo';
          const share = entry.share === null ? '' : ` ${Math.round(entry.share * 100)}%`;
          const count = `${entry.payer.billedModelRequests} ${
            entry.payer.billedModelRequests === 1 ? 'request' : 'requests'
          }`;
          const detached = entry.payer.detachReason
            ? ` · detached: ${entry.payer.detachReason}`
            : '';
          return `${payerLabel(entry.payer)}${share} (${count})${detached}`;
        })
        .join(' · ');
  return [paidText, ...platformText].join(' · ');
}

export function requesterLabel(request: PaidBenchmarkAdminRequest): string {
  const label =
    request.requester.ownerLabel ??
    `${request.requester.kind === 'org' ? 'Org' : 'User'} ${request.requester.ownerId}`;
  return request.requester.ownerId === request.requester.actorUserId
    ? label
    : `${label} · started by ${request.requester.actorUserId}`;
}

export function requestPoolLabel(request: PaidBenchmarkAdminRequest): string {
  return request.poolName ?? request.routerId;
}

/**
 * Actual spend next to the estimate and the full-cost figure the owner saw, plus the model
 * requests behind it. The figures are advisory: native billing charges each model request
 * as it happens, so a request can spend past them and nothing pauses it for that.
 * Kilo-covered requests are stated apart so an admin sees what the user was not billed for.
 */
export function requestSpendLine(request: PaidBenchmarkAdminRequest): string {
  const spend = formatMicrodollars(request.chargedMicrodollars);
  const maximum = formatMicrodollars(request.maximumMicrodollars);
  const estimate = formatMicrodollars(request.estimateMicrodollars);
  const covered =
    request.kiloCoveredModelRequests > 0
      ? ` · Kilo covered ${request.kiloCoveredModelRequests} ${request.kiloCoveredModelRequests === 1 ? 'request' : 'requests'} (${formatMicrodollars(request.kiloCoveredMicrodollars)})`
      : '';
  return `${spend} spent · estimated ${estimate} · full-cost ${maximum} · ${request.billedModelRequests} model ${request.billedModelRequests === 1 ? 'request' : 'requests'}${covered}`;
}

function caseStatusBadgeVariant(
  status: PaidBenchmarkCaseStatus
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'done') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'reused' || status === 'paused') return 'outline';
  return 'secondary';
}

/**
 * The user-paid queue of one router: who asked, who pays and how much so far, per-case
 * progress, and the pause that stops that request's spend immediately. Platform work is
 * shown by its own card because Kilo is both requester and payer there.
 */
export function BenchmarkRequestsSection({
  router,
  runs,
  runningRunIds,
}: {
  router: AutoRouter;
  runs: readonly BenchmarkRun[];
  runningRunIds: readonly string[];
}) {
  const [filter, setFilter] = useState<RequestsFilter>('all');

  const requestsQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-requests', router, filter],
    queryFn: async () => {
      const query = new URLSearchParams({ router });
      const statuses = REQUESTS_FILTER_STATUSES[filter];
      if (statuses !== null) query.set('status', statuses.join(','));
      const response = await adminFetch(
        `/admin/api/auto-routing/benchmark-requests?${query.toString()}`
      );
      return parseAdminResponse(response, PaidBenchmarkAdminListResponseSchema);
    },
    refetchInterval: query => {
      const data = query.state.data;
      return data &&
        data.requests.some(request => request.status === 'active' || request.status === 'preparing')
        ? REQUESTS_POLL_INTERVAL_MS
        : false;
    },
  });

  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const cancelRunMutation = useMutation({
    mutationFn: async (runId: string) => {
      const response = await adminFetch(
        `/admin/api/auto-routing/benchmark-runs/${encodeURIComponent(runId)}/cancel?router=${router}`,
        { method: 'POST' }
      );
      return parseAdminResponse(response, BenchmarkRunCancelResponseSchema);
    },
    onSuccess: data => {
      if (data.status === 'cancelled') toast.success('Run cancelled — it stops dispatching now');
      else if (data.status === 'already_finished') toast.info('Run had already finished');
      else toast.error('That run no longer exists');
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-runs', router] });
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-registry', router],
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel the run');
    },
  });

  const requestCancelRun = useCallback(
    async (run: BenchmarkRun) => {
      const approved = await confirm({
        title: 'Cancel this platform run?',
        description: `Stops ${run.id} and cancels its remaining cases. Kilo pays the work already done, and no user is charged. Platform benchmarking resumes automatically later.`,
        confirmLabel: 'Cancel run',
        destructive: true,
      });
      if (approved) cancelRunMutation.mutate(run.id);
    },
    [cancelRunMutation, confirm]
  );

  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-col gap-2 p-4 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">Benchmark requests</CardTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            User-paid pool benchmarks. A request only starts from the owner&apos;s explicit
            confirmation, and a pause stops its spend at once. Kilo pays its own platform queue.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Show</span>
          <Select value={filter} onValueChange={value => setFilter(value as RequestsFilter)}>
            <SelectTrigger
              className="h-8 w-36 text-xs"
              aria-label="Filter benchmark requests by status"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0">
        <PlatformQueueSummary
          runs={runs}
          runningRunIds={runningRunIds}
          onCancelRun={run => void requestCancelRun(run)}
          cancellingRunId={
            cancelRunMutation.isPending ? (cancelRunMutation.variables ?? null) : null
          }
        />
        {requestsQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : requestsQuery.error ? (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {requestsQuery.error instanceof Error
              ? requestsQuery.error.message
              : 'Failed to load benchmark requests'}
          </div>
        ) : (
          <BenchmarkRequestsList
            requests={requestsQuery.data?.requests ?? []}
            emptyFilter={filter}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The platform queue's side of the same picture: Kilo requests and pays. No user money is
 * involved, so there is no user pause; the operator can cancel one running run here, and
 * the operator lock stops dispatch entirely.
 */
export function PlatformQueueSummary({
  runs,
  runningRunIds,
  onCancelRun,
  cancellingRunId,
}: {
  runs: readonly BenchmarkRun[];
  runningRunIds: readonly string[];
  /** Present when the console can stop a running platform run. */
  onCancelRun?: (run: BenchmarkRun) => void;
  cancellingRunId?: string | null;
}) {
  const platformRuns = useMemo(
    () => runs.filter(run => run.purpose === 'platform' && run.kind === 'decider'),
    [runs]
  );
  const running = platformRuns.filter(
    run => run.status === 'running' || runningRunIds.includes(run.id)
  );
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Platform queue</Badge>
        <span className="text-xs">
          <span className="text-muted-foreground">Requester </span>Kilo platform
        </span>
        <span className="text-xs">
          <span className="text-muted-foreground">Payer </span>Kilo (100%)
        </span>
        <span className="text-muted-foreground text-xs">
          {running.length > 0
            ? `${running.length} ${running.length === 1 ? 'run' : 'runs'} in flight`
            : 'No run in flight'}
        </span>
      </div>
      {running.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {running.map(run => {
            const progress = run.progress ? formatRunProgress(run.progress, run.startedAt) : null;
            return (
              <li key={run.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs break-all">{run.id}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs tabular-nums">
                      {formatTotalUsd(run.totals?.totalCostUsd ?? null)} spent
                    </span>
                    {onCancelRun ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        disabled={cancellingRunId === run.id}
                        aria-label={`Cancel run ${run.id}`}
                        onClick={() => onCancelRun(run)}
                      >
                        <XCircle className="size-4" />
                        {cancellingRunId === run.id ? 'Cancelling' : 'Cancel run'}
                      </Button>
                    ) : null}
                  </span>
                </div>
                {progress ? (
                  <>
                    {progress.percent === null ? null : (
                      <Progress
                        value={progress.percent}
                        className="h-1.5"
                        aria-label={`Platform run progress: ${progress.counts}`}
                      />
                    )}
                    <span className="text-muted-foreground text-[11px] tabular-nums">
                      {progress.counts}
                      {progress.eta === null ? '' : ` · ETA ${progress.eta}`}
                    </span>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-muted-foreground mt-2 text-xs">
        Platform benchmarking is automatic: Kilo pays its own case runs from the moment it joins
        them, and a user pays nothing for those. Dispatch is governed by the operator lock, not by
        this console.
      </p>
    </div>
  );
}

function pauseOutcomeToast(status: 'paused' | 'already_paused' | 'not_active' | 'not_found') {
  if (status === 'paused') {
    toast.success('Request paused — its spend stops now; settled usage stands');
    return;
  }
  if (status === 'already_paused') {
    toast.info('Request is already paused');
    return;
  }
  if (status === 'not_active') {
    toast.error('That request is not spending any more');
    return;
  }
  toast.error('That request no longer exists');
}

export function BenchmarkRequestsList({
  requests,
  emptyFilter,
}: {
  requests: readonly PaidBenchmarkAdminRequest[];
  emptyFilter: RequestsFilter;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setExpandedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pauseMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const response = await adminFetch(
        `/admin/api/auto-routing/benchmark-requests/${encodeURIComponent(requestId)}/pause`,
        { method: 'POST' }
      );
      return parseAdminResponse(response, PaidBenchmarkAdminPauseResponseSchema);
    },
    onSuccess: data => {
      pauseOutcomeToast(data.status);
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-registry'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to pause the request');
    },
  });

  const requestPause = useCallback(
    async (request: PaidBenchmarkAdminRequest) => {
      const approved = await confirm({
        title: 'Pause this paid benchmark?',
        description: `Stops ${requesterLabel(request)}'s request immediately: no new case run is dispatched for it, and the runs only it pays for are cancelled. Usage already reported stays charged.`,
        confirmLabel: 'Pause request',
        destructive: true,
      });
      if (approved) pauseMutation.mutate(request.id);
    },
    [confirm, pauseMutation]
  );

  if (requests.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {emptyFilter === 'all'
          ? 'No paid pool benchmarks yet. A user starts one from their pool with an estimate first.'
          : 'No request matches this filter.'}
      </p>
    );
  }

  return (
    <>
      {/* Desktop: the operator's information density. */}
      <div className="hidden overflow-x-auto rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Requester · pool</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="w-56">Progress</TableHead>
              <TableHead>Payer split</TableHead>
              <TableHead>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map(request => {
              const expanded = expandedIds.has(request.id);
              const progress = requestCaseProgress(request);
              return (
                <React.Fragment key={request.id}>
                  <TableRow>
                    <TableCell className="py-2">
                      <button
                        type="button"
                        onClick={() => toggle(request.id)}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} request ${request.id}`}
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {expanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-64 py-2 text-xs">
                      <div>{requesterLabel(request)}</div>
                      <div
                        className="text-muted-foreground truncate font-mono text-[11px]"
                        title={requestPoolLabel(request)}
                      >
                        {requestPoolLabel(request)}
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge variant={STATUS_BADGE_VARIANT[request.status]} className="capitalize">
                        {request.status}
                      </Badge>
                      <div className="text-muted-foreground mt-1 text-[11px]">
                        {request.createdAt ? <AdminTimeLabel iso={request.createdAt} /> : null}
                      </div>
                      {request.failureReason ? (
                        <p
                          className="text-destructive mt-1 max-w-56 text-[11px] break-words whitespace-pre-wrap"
                          title={request.failureReason}
                        >
                          {request.failureReason}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      <div>{formatMicrodollars(request.chargedMicrodollars)}</div>
                      <div className="text-muted-foreground text-[11px]">
                        estimated {formatMicrodollars(request.estimateMicrodollars)} · full-cost{' '}
                        {formatMicrodollars(request.maximumMicrodollars)}
                      </div>
                      <div className="text-muted-foreground text-[11px]">
                        {request.billedModelRequests} model{' '}
                        {request.billedModelRequests === 1 ? 'request' : 'requests'}
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <Progress
                        value={progress.percent}
                        className="h-1.5"
                        aria-label={`Request progress: ${requestCaseLine(request)}`}
                      />
                      <span className="text-muted-foreground mt-1 block text-[11px] tabular-nums">
                        {requestCaseLine(request)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64 py-2 text-xs">
                      <span className="break-words">{payerSummary(request.payers)}</span>
                      {request.kiloCoveredModelRequests > 0 ? (
                        <div className="text-muted-foreground text-[11px]">
                          {request.kiloCoveredModelRequests} model{' '}
                          {request.kiloCoveredModelRequests === 1 ? 'request' : 'requests'} covered
                          by Kilo
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <PauseButton
                        request={request}
                        pausing={pauseMutation.isPending && pauseMutation.variables === request.id}
                        onPause={() => void requestPause(request)}
                      />
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="bg-muted/30">
                      <TableCell colSpan={7} className="px-4 py-3">
                        <RequestDetail request={request} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Narrow widths stack the same fields; the table above would squeeze them. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {requests.map(request => {
          const expanded = expandedIds.has(request.id);
          const progress = requestCaseProgress(request);
          return (
            <li key={request.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-xs">
                  <div className="break-words">{requesterLabel(request)}</div>
                  <div
                    className="text-muted-foreground truncate font-mono text-[11px]"
                    title={requestPoolLabel(request)}
                  >
                    {requestPoolLabel(request)}
                  </div>
                </div>
                <Badge variant={STATUS_BADGE_VARIANT[request.status]} className="capitalize">
                  {request.status}
                </Badge>
              </div>
              {request.failureReason ? (
                <p className="text-destructive mt-1 text-[11px] break-words whitespace-pre-wrap">
                  {request.failureReason}
                </p>
              ) : null}
              <Progress
                value={progress.percent}
                className="mt-2 h-1.5"
                aria-label={`Request progress: ${requestCaseLine(request)}`}
              />
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Spend</dt>
                <dd className="tabular-nums">{requestSpendLine(request)}</dd>
                <dt className="text-muted-foreground">Cases</dt>
                <dd className="tabular-nums">{requestCaseLine(request)}</dd>
                <dt className="text-muted-foreground">Payer</dt>
                <dd className="break-words">{payerSummary(request.payers)}</dd>
                {request.kiloCoveredModelRequests > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Covered</dt>
                    <dd>
                      {request.kiloCoveredModelRequests} model{' '}
                      {request.kiloCoveredModelRequests === 1 ? 'request' : 'requests'} by Kilo
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Started</dt>
                <dd>
                  <AdminTimeLabel iso={request.createdAt} />
                </dd>
              </dl>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  aria-expanded={expanded}
                  onClick={() => toggle(request.id)}
                >
                  {expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                  {expanded ? 'Hide details' : 'Details'}
                </Button>
                <PauseButton
                  request={request}
                  pausing={pauseMutation.isPending && pauseMutation.variables === request.id}
                  onPause={() => void requestPause(request)}
                  className="min-h-11"
                />
              </div>
              {expanded ? (
                <div className="mt-3">
                  <RequestDetail request={request} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PauseButton({
  request,
  pausing,
  onPause,
  className,
}: {
  request: PaidBenchmarkAdminRequest;
  pausing: boolean;
  onPause: () => void;
  className?: string;
}) {
  const canPause = request.status === 'preparing' || request.status === 'active';
  if (!canPause) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('shrink-0', className)}
      disabled={pausing}
      aria-label={`Pause request ${request.id}`}
      onClick={onPause}
    >
      <PauseCircle className="size-4" />
      {pausing ? 'Pausing' : 'Pause'}
    </Button>
  );
}

/**
 * Per-case progress and the pool routing result of one request. Mounted only while the
 * row is expanded, so a list of requests costs one request each, on demand.
 */
export function RequestDetail({ request }: { request: PaidBenchmarkAdminRequest }) {
  const [extraCases, setExtraCases] = useState<PaidBenchmarkAdminProgressResponse['cases']>([]);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [showRouting, setShowRouting] = useState(false);
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;

  const progressQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-request-progress', request.id, cursor],
    queryFn: async () => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const response = await adminFetch(
        `/admin/api/auto-routing/benchmark-requests/${encodeURIComponent(request.id)}/progress${query}`
      );
      return parseAdminResponse(response, PaidBenchmarkAdminProgressResponseSchema);
    },
  });

  const routingQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-request-routing-table', request.id],
    enabled: showRouting,
    queryFn: async () => {
      const response = await adminFetch(
        `/admin/api/auto-routing/benchmark-requests/${encodeURIComponent(request.id)}/routing-table`,
        { method: 'POST' }
      );
      return parseAdminResponse(response, PaidBenchmarkAdminRoutingTableResponseSchema);
    },
  });

  const cases = [...(progressQuery.data?.cases ?? []), ...extraCases];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs tabular-nums">{requestSpendLine(request)}</p>
      {request.status === 'paused' && request.pauseReason !== null ? (
        <p className="text-xs">
          <span className="text-muted-foreground">Paused </span>
          {request.pauseReason === 'no_funds'
            ? 'because billing refused a payer (no funds); usage already billed stands'
            : 'by its owner'}
        </p>
      ) : null}
      {request.status === 'failed' && request.failureReason ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
        >
          <p className="font-medium">Request failed</p>
          <p className="break-words whitespace-pre-wrap">{request.failureReason}</p>
          <p className="mt-1">
            {request.failureRetryable
              ? 'Retryable: a fresh confirmation re-runs the remaining cases.'
              : 'Not retryable: a failed model stays blocked until its own re-admission.'}
          </p>
        </div>
      ) : null}
      <div>
        <h4 className="mb-1 text-xs font-medium">Cases</h4>
        {progressQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : progressQuery.error ? (
          <p className="text-destructive text-xs">
            {progressQuery.error instanceof Error
              ? progressQuery.error.message
              : 'Failed to load case progress'}
          </p>
        ) : cases.length === 0 ? (
          <p className="text-muted-foreground text-xs">No cases planned yet</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table className="w-full table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Model</TableHead>
                    <TableHead className="w-24 text-xs">Case</TableHead>
                    <TableHead className="w-20 text-xs">Status</TableHead>
                    <TableHead className="w-24 text-right text-xs">Charged</TableHead>
                    <TableHead className="text-xs">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell className="max-w-0 text-xs">
                        <span className="block truncate font-mono" title={entry.model}>
                          {entry.model}
                        </span>
                        <span className="text-muted-foreground block truncate text-[11px]">
                          {entry.variant ?? 'default'} · repetition {entry.repetition}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-0 text-xs">
                        <span className="block truncate font-mono" title={entry.caseId}>
                          {entry.caseId}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={caseStatusBadgeVariant(entry.status)}
                          className="capitalize"
                        >
                          {entry.status}
                        </Badge>
                        {entry.coveredByKilo ? (
                          <span className="text-muted-foreground mt-1 block text-[11px]">
                            covered by Kilo
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatMicrodollars(entry.chargedMicrodollars)}
                        <span className="text-muted-foreground block text-[11px]">
                          {entry.billedModelRequests}{' '}
                          {entry.billedModelRequests === 1 ? 'request' : 'requests'}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-64 text-xs">
                        {entry.reason ? (
                          <span className="block break-words whitespace-pre-wrap">
                            {entry.reason}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {progressQuery.data?.nextCursor ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 min-h-11"
                onClick={() => {
                  const next = progressQuery.data?.nextCursor;
                  if (!next) return;
                  setExtraCases(previous => [...previous, ...(progressQuery.data?.cases ?? [])]);
                  setCursors(previous => [...previous, next]);
                }}
              >
                Load more cases
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          aria-expanded={showRouting}
          onClick={() => setShowRouting(value => !value)}
        >
          <Route className="size-4" />
          {showRouting ? 'Hide routing result' : 'Show routing result'}
        </Button>
        {showRouting ? (
          routingQuery.isLoading ? (
            <Skeleton className="mt-2 h-24 w-full" />
          ) : routingQuery.error ? (
            <p className="text-destructive mt-2 text-xs">
              {routingQuery.error instanceof Error
                ? routingQuery.error.message
                : 'Failed to load the routing result'}
            </p>
          ) : routingQuery.data ? (
            <div className="mt-2">
              {routingQuery.data.table === null ? (
                <p className="text-muted-foreground text-xs">
                  No routing result yet: the pool has no measured pair to rank for this router.
                </p>
              ) : (
                <RoutingTableView data={{ table: routingQuery.data.table, publishedAt: null }} />
              )}
            </div>
          ) : null
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Engine-scoped results are shared: a case whose result already exists at this engine shows as
        reused and is never charged again. Two pools on one account count as one payer.
      </p>
    </div>
  );
}
