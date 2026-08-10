'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  applyDataExportFilters,
  MAX_SEARCH_LENGTH,
  parseDataExportFilters,
  parseEmailStatusFilter,
  parseHealthFilter,
  parseStatusFilter,
  type DataExportEmailStatusFilter,
  type DataExportFilters,
  type DataExportHealthFilter,
  type DataExportStatusFilter,
} from './data-export-filters';
import { formatTimestamp } from './data-export-format';
import { DataExportsSummaryStrip } from './DataExportsSummaryStrip';
import { DataExportsTable } from './DataExportsTable';

const PAGE_SIZE = 25;

const healthOptions: Array<{ value: DataExportHealthFilter; label: string }> = [
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'active', label: 'Active' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'all', label: 'All exports' },
];

const statusOptions: Array<{ value: DataExportStatusFilter | 'any'; label: string }> = [
  { value: 'any', label: 'Any status' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'finalizing', label: 'Finalizing' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Failed' },
  { value: 'expired', label: 'Expired' },
];

const emailStatusOptions: Array<{ value: DataExportEmailStatusFilter | 'any'; label: string }> = [
  { value: 'any', label: 'Any email status' },
  { value: 'pending', label: 'Pending' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
];

export function DataExportsContent() {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseDataExportFilters(searchParams);
  const desiredFiltersRef = useRef(filters);
  const pendingQueryRef = useRef<string | null>(null);
  const [isNavigationLocked, setIsNavigationLocked] = useState(false);
  const [isNavigationPending, startNavigation] = useTransition();

  const [searchDraft, setSearchDraft] = useState(filters.search ?? '');
  useEffect(() => {
    desiredFiltersRef.current = filters;
  }, [filters.emailStatus, filters.health, filters.page, filters.search, filters.status]);
  useEffect(() => {
    if (pendingQueryRef.current === null || pendingQueryRef.current !== searchParams.toString())
      return;
    pendingQueryRef.current = null;
    setIsNavigationLocked(false);
  }, [searchParams]);
  useEffect(() => setSearchDraft(filters.search ?? ''), [filters.search]);

  const summaryQuery = useQuery(trpc.admin.userDataExports.summary.queryOptions());
  const listQuery = useQuery({
    ...trpc.admin.userDataExports.list.queryOptions({
      page: filters.page,
      limit: PAGE_SIZE,
      health: filters.health,
      status: filters.status,
      emailStatus: filters.emailStatus,
      search: filters.search,
    }),
    placeholderData: keepPreviousData,
  });

  const updateFilters = useCallback(
    (next: Partial<DataExportFilters>) => {
      const merged: DataExportFilters = { ...desiredFiltersRef.current, ...next };
      desiredFiltersRef.current = merged;
      const params = applyDataExportFilters(searchParams, merged);
      const queryString = params.toString();
      if (queryString === searchParams.toString()) return;
      pendingQueryRef.current = queryString;
      setIsNavigationLocked(true);
      startNavigation(() => {
        router.push(`${pathname}${queryString ? `?${queryString}` : ''}`, { scroll: false });
      });
    },
    [pathname, router, searchParams]
  );

  const updateFilterAndResetPage = useCallback(
    (next: Partial<DataExportFilters>) => updateFilters({ ...next, page: 1 }),
    [updateFilters]
  );

  const submitSearch = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const search = searchDraft.trim();
      updateFilterAndResetPage({ search: search.length > 0 ? search : undefined });
    },
    [searchDraft, updateFilterAndResetPage]
  );

  const clearSearch = useCallback(() => {
    setSearchDraft('');
    updateFilterAndResetPage({ search: undefined });
  }, [updateFilterAndResetPage]);

  const refresh = useCallback(() => {
    void summaryQuery.refetch();
    void listQuery.refetch();
  }, [summaryQuery, listQuery]);

  const isRefreshing = summaryQuery.isFetching || listQuery.isFetching;
  const rows = listQuery.data?.rows ?? [];
  const pagination = listQuery.data?.pagination;
  const asOf = listQuery.data?.asOf ?? summaryQuery.data?.asOf;
  const normalizedPage = pagination?.page;

  useEffect(() => {
    if (
      normalizedPage === undefined ||
      normalizedPage === filters.page ||
      listQuery.isFetching ||
      listQuery.isPlaceholderData ||
      isNavigationPending
    )
      return;
    const normalized = { ...filters, page: normalizedPage };
    desiredFiltersRef.current = normalized;
    const params = applyDataExportFilters(searchParams, normalized);
    const queryString = params.toString();
    if (queryString === searchParams.toString()) return;
    pendingQueryRef.current = queryString;
    setIsNavigationLocked(true);
    startNavigation(() => {
      router.replace(`${pathname}${queryString ? `?${queryString}` : ''}`, { scroll: false });
    });
  }, [
    filters,
    isNavigationPending,
    listQuery.isFetching,
    listQuery.isPlaceholderData,
    normalizedPage,
    pathname,
    router,
    searchParams,
  ]);

  const controlsDisabled = isNavigationLocked || isNavigationPending;
  const currentPage = pagination?.page ?? filters.page;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Data export health</h2>
          <p className="text-muted-foreground max-w-4xl">
            Read-only control-plane view of the user data export workload. Workers, reconcilers, and
            cleanup jobs act on these signals automatically. This page never mutates exports.
            {asOf ? ` Snapshot from ${formatTimestamp(asOf)}.` : ''}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-fit self-start"
          onClick={refresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={isRefreshing ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {summaryQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Workload summary could not load</AlertTitle>
          <AlertDescription>
            The summary is unavailable. The export list below may still work. Use Refresh to try
            again.
          </AlertDescription>
        </Alert>
      ) : (
        <DataExportsSummaryStrip summary={summaryQuery.data} isLoading={summaryQuery.isLoading} />
      )}

      <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <div className="flex flex-col gap-1 text-sm">
            <Label htmlFor="data-export-health-filter" className="text-xs">
              Health
            </Label>
            <Select
              value={filters.health}
              disabled={controlsDisabled}
              onValueChange={value =>
                updateFilterAndResetPage({ health: parseHealthFilter(value) })
              }
            >
              <SelectTrigger id="data-export-health-filter" className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {healthOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <Label htmlFor="data-export-status-filter" className="text-xs">
              Status
            </Label>
            <Select
              value={filters.status ?? 'any'}
              disabled={controlsDisabled}
              onValueChange={value =>
                updateFilterAndResetPage({ status: parseStatusFilter(value) })
              }
            >
              <SelectTrigger id="data-export-status-filter" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <Label htmlFor="data-export-email-filter" className="text-xs">
              Email status
            </Label>
            <Select
              value={filters.emailStatus ?? 'any'}
              disabled={controlsDisabled}
              onValueChange={value =>
                updateFilterAndResetPage({ emailStatus: parseEmailStatusFilter(value) })
              }
            >
              <SelectTrigger id="data-export-email-filter" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {emailStatusOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <form
          onSubmit={submitSearch}
          className="flex flex-col gap-1 text-sm sm:flex-row sm:items-end xl:ml-auto"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="data-export-search" className="text-xs">
              Exact search
            </Label>
            <Input
              id="data-export-search"
              value={searchDraft}
              onChange={event => setSearchDraft(event.target.value)}
              placeholder="Export ID, user ID, or email"
              maxLength={MAX_SEARCH_LENGTH}
              disabled={controlsDisabled}
              className="w-full sm:w-72"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="h-9"
              disabled={controlsDisabled}
            >
              <Search /> Search
            </Button>
            {filters.search || searchDraft ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={clearSearch}
                disabled={controlsDisabled}
              >
                <X /> Clear
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        Search matches an exact export ID, user ID, or email address.
      </p>

      {listQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Data exports could not load</AlertTitle>
          <AlertDescription>
            {listQuery.error.message || 'Refresh the page or adjust the filters to try again.'}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {listQuery.isFetching && !listQuery.isLoading ? (
            <p className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
              <RefreshCw className="size-3 animate-spin" /> Updating results…
            </p>
          ) : null}
          <DataExportsTable rows={rows} asOf={asOf} isLoading={listQuery.isLoading} />
          <div className="flex flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center">
            <p className="text-muted-foreground">
              {pagination
                ? `${pagination.total.toLocaleString()} export${pagination.total === 1 ? '' : 's'} · page ${pagination.page} of ${Math.max(pagination.totalPages, 1)}`
                : 'Loading export count...'}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateFilters({ page: Math.max(1, currentPage - 1) })}
                disabled={currentPage <= 1 || listQuery.isFetching || controlsDisabled}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateFilters({ page: currentPage + 1 })}
                disabled={
                  !pagination ||
                  currentPage >= pagination.totalPages ||
                  listQuery.isFetching ||
                  controlsDisabled
                }
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
