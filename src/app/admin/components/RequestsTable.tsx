'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAdminRequests } from '@/app/admin/api/requests/hooks';
import { RequestDetailDialog } from './RequestDetailDialog';

type SortOrder = 'asc' | 'desc';

function toSortedSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value) params.set(key, String(value));
  }
  return params;
}

function statusCodeVariant(code: number | null): 'default' | 'secondary' | 'destructive' {
  if (code === null) return 'secondary';
  if (code >= 200 && code < 300) return 'default';
  if (code >= 400 && code < 500) return 'secondary';
  return 'destructive';
}

export function RequestsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryStringState = useMemo(
    () => ({
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '25'),
      sortOrder: (searchParams.get('sortOrder') || 'desc') as SortOrder,
      requestId: searchParams.get('requestId') || '',
      startTime: searchParams.get('startTime') || '',
      endTime: searchParams.get('endTime') || '',
      query: searchParams.get('query') || '',
    }),
    [searchParams]
  );

  const [queryInput, setQueryInput] = useState(queryStringState.query);
  const [requestIdInput, setRequestIdInput] = useState(queryStringState.requestId);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Sync local inputs when URL params change externally
  useEffect(() => {
    setQueryInput(queryStringState.query);
  }, [queryStringState.query]);

  useEffect(() => {
    setRequestIdInput(queryStringState.requestId);
  }, [queryStringState.requestId]);

  const { data, isLoading, error, isFetching } = useAdminRequests({
    page: queryStringState.page,
    limit: queryStringState.limit,
    sortOrder: queryStringState.sortOrder,
    requestId: queryStringState.requestId || undefined,
    startTime: queryStringState.startTime || undefined,
    endTime: queryStringState.endTime || undefined,
    query: queryStringState.query || undefined,
  });

  type QueryStringState = typeof queryStringState;

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/requests?${queryString.toString()}`);
    },
    [router, queryStringState]
  );

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryInput !== queryStringState.query) {
        pushWith({ query: queryInput, page: 1 });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [queryInput, queryStringState.query, pushWith]);

  const handleRequestIdSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      pushWith({ requestId: requestIdInput, page: 1 });
    },
    [pushWith, requestIdInput]
  );

  const handleClearFilters = useCallback(() => {
    setQueryInput('');
    setRequestIdInput('');
    pushWith({ query: '', requestId: '', startTime: '', endTime: '', page: 1 });
  }, [pushWith]);

  const handlePageChange = useCallback(
    (page: number) => {
      pushWith({ page });
    },
    [pushWith]
  );

  const handleRowClick = useCallback((id: string) => {
    setSelectedRequestId(id);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setSelectedRequestId(null);
    }
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load API requests</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const items = data?.items ?? [];
  const pagination = data?.pagination ?? {
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 1,
  };

  return (
    <div className="flex w-full flex-col gap-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="query-search" className="text-xs mb-1 block">
            Search
          </Label>
          <div className="relative">
            <Input
              id="query-search"
              placeholder="Search by user, org, provider, model, or ID..."
              value={queryInput}
              onChange={e => setQueryInput(e.target.value)}
              className="pr-8"
            />
            {queryInput && (
              <button
                type="button"
                onClick={() => {
                  setQueryInput('');
                  pushWith({ query: '', page: 1 });
                }}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <form onSubmit={handleRequestIdSubmit} className="flex items-end gap-2">
          <div>
            <Label htmlFor="request-id" className="text-xs mb-1 block">
              Request ID
            </Label>
            <Input
              id="request-id"
              placeholder="Exact ID..."
              value={requestIdInput}
              onChange={e => setRequestIdInput(e.target.value)}
              className="w-40"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={isFetching}>
            Go
          </Button>
        </form>

        <div>
          <Label htmlFor="start-time" className="text-xs mb-1 block">
            Start Time
          </Label>
          <Input
            id="start-time"
            type="datetime-local"
            value={queryStringState.startTime ? queryStringState.startTime.slice(0, 16) : ''}
            onChange={e => {
              const val = e.target.value;
              pushWith({ startTime: val ? new Date(val).toISOString() : '', page: 1 });
            }}
            className="w-48"
          />
        </div>

        <div>
          <Label htmlFor="end-time" className="text-xs mb-1 block">
            End Time
          </Label>
          <Input
            id="end-time"
            type="datetime-local"
            value={queryStringState.endTime ? queryStringState.endTime.slice(0, 16) : ''}
            onChange={e => {
              const val = e.target.value;
              pushWith({ endTime: val ? new Date(val).toISOString() : '', page: 1 });
            }}
            className="w-48"
          />
        </div>

        <Button variant="ghost" size="sm" onClick={handleClearFilters}>
          Clear All
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead>User ID</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  Loading API requests...
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No API requests found.
                </TableCell>
              </TableRow>
            ) : (
              items.map(item => (
                <TableRow
                  key={item.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  onClick={() => handleRowClick(item.id)}
                >
                  <TableCell className="font-mono text-sm">{item.id}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(item.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-sm max-w-[200px] truncate">
                    {item.kilo_user_id ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm">{item.provider ?? '—'}</TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate">
                    {item.model ?? '—'}
                  </TableCell>
                  <TableCell>
                    {item.status_code !== null ? (
                      <Badge variant={statusCodeVariant(item.status_code)}>
                        {item.status_code}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-muted-foreground text-sm">
          Showing {items.length > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0} to{' '}
          {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}{' '}
          requests
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(pagination.page - 1)}
            disabled={pagination.page <= 1 || isFetching}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <div className="text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages || isFetching}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <RequestDetailDialog
        requestId={selectedRequestId}
        open={dialogOpen}
        onOpenChange={handleDialogClose}
      />
    </div>
  );
}
