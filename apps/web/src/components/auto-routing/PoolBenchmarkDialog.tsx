'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React, { useEffect, useMemo, useState } from 'react';
import type {
  CustomRouterSummary,
  PaidBenchmarkCaseStatus,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useTRPC } from '@/lib/trpc/utils';
import { BenchmarkProgressPanel } from './BenchmarkProgressPanel';
import { BenchmarkQuotePanel } from './BenchmarkQuotePanel';
import { BenchmarkRoutingTable } from './BenchmarkRoutingTable';
import {
  BENCHMARK_PENDING_RECEIPT_POLL_INTERVAL_MS,
  BENCHMARK_PROGRESS_POLL_INTERVAL_MS,
  type BenchmarkFailureCopy,
  type CasePageState,
  applyCasePage,
  beginCasePage,
  benchmarkRequestErrorCopy,
  casePageState,
  failCasePage,
  mergeCases,
  startFailureCopy,
} from './benchmark-display';
import { customRoutersQueryKey, entryLabel } from './custom-router-display';
import { PoolBenchmarkWarnings } from './PoolBenchmarkWarnings';

type Props = {
  router: CustomRouterSummary;
  organizationId: string | undefined;
  onClose: () => void;
};

/**
 * The pool's benchmark surface: a reviewed estimate, explicit start, live
 * progress with pause, and the resulting routing table. Every request here is
 * owner-initiated; opening the dialog only reads.
 */
export function PoolBenchmarkDialog({ router, organizationId, onClose }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const slug = router.slug;
  const [tab, setTab] = useState<'benchmark' | 'routing-table'>('benchmark');
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [showQuote, setShowQuote] = useState(false);
  const [startFailure, setStartFailure] = useState<BenchmarkFailureCopy | null>(null);
  /** What a second confirmation replaced: shown while the request it named is still live. */
  const [startNoticeFor, setStartNoticeFor] = useState<{
    requestId: string;
    copy: BenchmarkFailureCopy;
  } | null>(null);
  const [pauseFailure, setPauseFailure] = useState<BenchmarkFailureCopy | null>(null);
  const [filter, setFilter] = useState<PaidBenchmarkCaseStatus | 'all'>('all');
  const [pagination, setPagination] = useState<CasePageState | null>(null);
  const [quoteRequested, setQuoteRequested] = useState(false);
  const hasAliasEntry = router.entries.some(
    entry => entry.entry.kind === 'gateway' && entry.entry.model.startsWith('~')
  );
  // The catalog's live alias targets only matter for a pool that has an alias.
  const modelsQuery = useModelSelectorList(organizationId, hasAliasEntry);
  const aliasTargets = useMemo(() => {
    const targets = new Map<string, string>();
    for (const model of modelsQuery.data?.data ?? []) {
      if (model.alias_target !== undefined) targets.set(model.id, model.alias_target);
    }
    return targets;
  }, [modelsQuery.data]);

  const progressQuery = useQuery({
    ...trpc.customRouterBenchmarks.progress.queryOptions({ slug, organizationId, requestId }),
    refetchInterval: current => {
      const data = current.state.data;
      if (data === undefined || data.status === 'empty') return false;
      if (data.status === 'active' || data.status === 'preparing') {
        return BENCHMARK_PROGRESS_POLL_INTERVAL_MS;
      }
      // A settled request may still have admitted calls with no receipt yet.
      return (data.pendingModelRequests ?? 0) > 0
        ? BENCHMARK_PENDING_RECEIPT_POLL_INTERVAL_MS
        : false;
    },
  });
  // A quote is a read of the whole pool's missing work. Issue one only when the
  // pool has no benchmark request to show, or the owner explicitly asks.
  const quoteEnabled = quoteRequested || progressQuery.data?.status === 'empty';
  const quoteQuery = useQuery({
    ...trpc.customRouterBenchmarks.quote.queryOptions({ slug, organizationId }),
    enabled: quoteEnabled,
  });
  const tableQuery = useQuery({
    ...trpc.customRouterBenchmarks.table.queryOptions({ slug, organizationId }),
    enabled: tab === 'routing-table',
  });

  const startMutation = useMutation(
    trpc.customRouterBenchmarks.start.mutationOptions({
      onSuccess: result => {
        const copy = startFailureCopy(result);
        if (result.status === 'started' && result.alreadyInProgress === true) {
          // Another tab, or a quote taken before this request existed: show the request that
          // is already staging instead of failing. Nothing new was created or charged. The
          // notice is bound to that request and drops as soon as it settles.
          setStartNoticeFor(
            copy === null || result.request.status === 'empty'
              ? null
              : { requestId: result.request.id, copy }
          );
          setStartFailure(null);
        } else if (result.status === 'started') {
          setStartNoticeFor(null);
          setStartFailure(null);
        } else {
          setStartFailure(copy);
          setStartNoticeFor(null);
          return;
        }
        setPauseFailure(null);
        setFilter('all');
        setPagination(null);
        setQuoteRequested(false);
        if (result.request.status !== 'empty') setRequestId(result.request.id);
        setShowQuote(false);
      },
      onError: error => setStartFailure(benchmarkRequestErrorCopy(error)),
    })
  );

  const pauseMutation = useMutation(
    trpc.customRouterBenchmarks.pause.mutationOptions({
      onMutate: () => setPauseFailure(null),
      onSuccess: () => {
        // The paused receipt is the server's settlement on the next progress
        // read; nothing about reserved credit is derived here.
        void queryClient.invalidateQueries({
          queryKey: trpc.customRouterBenchmarks.progress.queryKey({
            slug,
            organizationId,
            requestId,
          }),
        });
        void progressQuery.refetch();
        void queryClient.invalidateQueries({ queryKey: customRoutersQueryKey(organizationId) });
      },
      onError: error => setPauseFailure(benchmarkRequestErrorCopy(error)),
    })
  );

  const progress = progressQuery.data;
  const activeProgress =
    progress !== undefined && progress.status !== 'empty' ? progress : undefined;
  const progressId = activeProgress?.id;
  // A terminal request keeps its settled receipt; a pool with no request at all
  // is the only case that needs a fresh quote without being asked.
  const hasRequest = activeProgress !== undefined;

  useEffect(() => {
    // A different request gets its own filter and page state. The page state is
    // also keyed by request, so a late page cannot land on the next request.
    setFilter('all');
    setPagination(null);
  }, [progressId]);

  useEffect(() => {
    // A request that appears supersedes a quote view: the estimate describes the
    // pool's missing work, not a request that is now shown.
    if (hasRequest) setShowQuote(false);
  }, [hasRequest]);

  useEffect(() => {
    // A finished or paused request changed the pool's entry statuses and table.
    if (progress?.status === 'completed' || progress?.status === 'paused') {
      void queryClient.invalidateQueries({ queryKey: customRoutersQueryKey(organizationId) });
      void queryClient.invalidateQueries({
        queryKey: trpc.customRouterBenchmarks.table.queryKey({ slug, organizationId }),
      });
    }
  }, [progress?.status, organizationId, queryClient, slug, trpc]);

  useEffect(() => {
    // The second-confirmation notice describes one request in flight. Once that request
    // completes, pauses or fails there is nothing to announce, so it is dropped here rather
    // than lingering as a stale banner over the settled result.
    if (startNoticeFor === null) return;
    if (
      activeProgress === undefined ||
      activeProgress.id !== startNoticeFor.requestId ||
      (activeProgress.status !== 'preparing' && activeProgress.status !== 'active')
    )
      setStartNoticeFor(null);
  }, [activeProgress, startNoticeFor]);

  const pageState = casePageState(pagination, progressId);
  const extraCases = pageState.kind === 'first' ? [] : pageState.cases;
  const cases = useMemo(
    () => mergeCases(activeProgress?.cases ?? [], extraCases),
    [activeProgress?.cases, extraCases]
  );
  const nextCursor =
    pageState.kind === 'first' ? (activeProgress?.nextCursor ?? null) : pageState.cursor;
  const loadingMore = pageState.kind === 'loading';
  const loadMoreFailure = pageState.kind === 'failed' ? pageState.failure : null;

  const loadMore = async () => {
    if (activeProgress === undefined || nextCursor === null || loadingMore) return;
    const requestIdAtStart = activeProgress.id;
    const cursor = nextCursor;
    setPagination(current =>
      beginCasePage(casePageState(current, requestIdAtStart), requestIdAtStart, cursor)
    );
    try {
      const page = await queryClient.fetchQuery(
        trpc.customRouterBenchmarks.progress.queryOptions({
          slug,
          organizationId,
          requestId: requestIdAtStart,
          cursor,
        })
      );
      const result =
        page.status === 'empty'
          ? { cases: [], nextCursor: null }
          : { cases: page.cases, nextCursor: page.nextCursor };
      // The reducer drops this answer if the user switched request or cursor.
      setPagination(current =>
        current === null ? current : applyCasePage(current, requestIdAtStart, cursor, result)
      );
    } catch (error) {
      const failure = benchmarkRequestErrorCopy(error);
      setPagination(current =>
        current === null ? current : failCasePage(current, requestIdAtStart, cursor, failure)
      );
    }
  };

  const requestFreshEstimate = () => {
    setStartFailure(null);
    setShowQuote(true);
    if (quoteEnabled) {
      void quoteQuery.refetch();
    } else {
      setQuoteRequested(true);
    }
  };

  const defaultEntry = router.entries.find(entry => entry.key === router.defaultEntryKey);
  const defaultEntryLabel = defaultEntry ? entryLabel(defaultEntry.entry) : router.defaultEntryKey;
  const showProgress = activeProgress !== undefined && !showQuote;
  const progressErrorCopy =
    progressQuery.isError && progressQuery.data === undefined
      ? benchmarkRequestErrorCopy(progressQuery.error)
      : null;
  const quoteErrorCopy = quoteQuery.isError ? benchmarkRequestErrorCopy(quoteQuery.error) : null;
  const tableErrorCopy =
    tableQuery.isError && tableQuery.data === undefined
      ? benchmarkRequestErrorCopy(tableQuery.error)
      : null;

  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Benchmark {router.name}</DialogTitle>
          <DialogDescription>
            Measure the models in this pool so it can route each request. You review the cost and
            start it yourself; nothing runs or charges on its own.
          </DialogDescription>
        </DialogHeader>

        <PoolBenchmarkWarnings router={router} aliasTargets={aliasTargets} />

        <Tabs
          value={tab}
          onValueChange={value => setTab(value === 'routing-table' ? 'routing-table' : 'benchmark')}
        >
          <TabsList>
            <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
            <TabsTrigger value="routing-table">Routing table</TabsTrigger>
          </TabsList>

          <TabsContent value="benchmark" className="space-y-4">
            {progressQuery.isRefetchError && activeProgress !== undefined ? (
              <Alert variant="destructive">
                <AlertTitle>Could not refresh progress</AlertTitle>
                <AlertDescription>
                  Showing the last update. Pause still works; retry to refresh.
                </AlertDescription>
              </Alert>
            ) : null}
            {showProgress && activeProgress !== undefined ? (
              <>
                {startNoticeFor !== null &&
                (activeProgress.status === 'preparing' || activeProgress.status === 'active') ? (
                  // Neutral, not an error: the pool's own request is simply already in flight.
                  <Alert variant="notice">
                    <AlertTitle>{startNoticeFor.copy.title}</AlertTitle>
                    <AlertDescription>{startNoticeFor.copy.description}</AlertDescription>
                  </Alert>
                ) : null}
                <BenchmarkProgressPanel
                  progress={activeProgress}
                  cases={cases}
                  filter={filter}
                  onFilterChange={setFilter}
                  hasMore={nextCursor !== null}
                  loadingMore={loadingMore}
                  onLoadMore={() => void loadMore()}
                  pausePending={pauseMutation.isPending}
                  error={pauseFailure ?? loadMoreFailure}
                  onPause={() => {
                    if (activeProgress !== undefined) {
                      pauseMutation.mutate({
                        slug,
                        organizationId,
                        requestId: activeProgress.id,
                      });
                    }
                  }}
                  onFreshEstimate={requestFreshEstimate}
                  quotePending={quoteQuery.isFetching}
                  onRefreshProgress={() => void progressQuery.refetch()}
                  refreshPending={progressQuery.isFetching}
                />
              </>
            ) : progressQuery.isLoading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : progressErrorCopy !== null ? (
              <RequestError
                failure={progressErrorCopy}
                retry={progressErrorCopy.retryable ? () => void progressQuery.refetch() : undefined}
              />
            ) : quoteQuery.isLoading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : quoteErrorCopy !== null ? (
              <RequestError
                failure={quoteErrorCopy}
                retry={quoteErrorCopy.retryable ? () => void quoteQuery.refetch() : undefined}
              />
            ) : quoteQuery.data !== undefined ? (
              <BenchmarkQuotePanel
                quote={quoteQuery.data}
                failure={startFailure}
                startPending={startMutation.isPending}
                refreshPending={quoteQuery.isFetching}
                onStart={() => {
                  if (quoteQuery.data?.status === 'ready') {
                    startMutation.mutate({
                      slug,
                      organizationId,
                      quoteId: quoteQuery.data.id,
                    });
                  }
                }}
                onRefreshQuote={requestFreshEstimate}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="routing-table" className="space-y-4">
            {tableQuery.isLoading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-40 w-full" />
              </div>
            ) : tableErrorCopy !== null ? (
              <RequestError
                failure={tableErrorCopy}
                retry={tableErrorCopy.retryable ? () => void tableQuery.refetch() : undefined}
              />
            ) : tableQuery.data !== undefined ? (
              <BenchmarkRoutingTable
                table={tableQuery.data.table}
                mode={router.mode}
                defaultEntryLabel={defaultEntryLabel}
                servingPins={tableQuery.data.servingPins}
              />
            ) : null}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestError({
  failure,
  retry,
}: {
  failure: BenchmarkFailureCopy;
  retry: (() => void) | undefined;
}) {
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <AlertTitle>{failure.title}</AlertTitle>
        <AlertDescription>{failure.description}</AlertDescription>
      </Alert>
      {retry !== undefined ? (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
