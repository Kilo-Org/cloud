'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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

  const [searchDraft, setSearchDraft] = useState(filters.search ?? '');
  useEffect(() => {
    setSearchDraft(filters.search ?? '');
  }, [filters.search]);

  const summaryQuery = useQuery(trpc.admin.userDataExports.summary.queryOptions());
  const listQuery = useQuery(
    trpc.admin.userDataExports.list.queryOptions({
      page: filters.page,
      limit: PAGE_SIZE,
      health: filters.health,
      status: filters.status,
      emailStatus: filters.emailStatus,
      search: filters.search,
    })
  );

  const updateFilters = useCallback(
    (next: Partial<DataExportFilters>) => {
      const merged: DataExportFilters = { ...filters, ...next };
      const params = applyDataExportFilters(searchParams, merged);
      const queryString = params.toString();
      router.push(`${pathname}${queryString ? `?${queryString}` : ''}`, { scroll: false });
    },
    [filters, pathname, router, searchParams]
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
              className="w-full sm:w-72"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" className="h-9">
              <Search /> Search
            </Button>
            {filters.search || searchDraft ? (
              <Button type="button" variant="ghost" size="sm" className="h-9" onClick={clearSearch}>
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
                onClick={() => updateFilters({ page: Math.max(1, filters.page - 1) })}
                disabled={filters.page <= 1 || listQuery.isFetching}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateFilters({ page: filters.page + 1 })}
                disabled={
                  !pagination || filters.page >= pagination.totalPages || listQuery.isFetching
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
