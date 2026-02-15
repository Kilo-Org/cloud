'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, X, ChevronUp, ChevronDown, Eye, ArrowLeft, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';
import { useRequestLogsList } from '@/app/admin/api/requests/hooks';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';

type SortBy = 'created_at' | 'status_code' | 'provider' | 'model';
type SortOrder = 'asc' | 'desc';

type Filters = {
  requestId: string;
  search: string;
  fromDate: string;
  toDate: string;
  provider: string;
  model: string;
  statusCode: string;
  kiloUserId: string;
  organizationId: string;
};

const emptyFilters: Filters = {
  requestId: '',
  search: '',
  fromDate: '',
  toDate: '',
  provider: '',
  model: '',
  statusCode: '',
  kiloUserId: '',
  organizationId: '',
};

type RequestLog = {
  id: string;
  created_at: string;
  kilo_user_id: string | null;
  organization_id: string | null;
  provider: string | null;
  model: string | null;
  status_code: number | null;
  request?: unknown;
  response: string | null;
};

function tryParseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function StatusBadge({ code }: { code: number | null }) {
  if (code === null) return <Badge variant="outline">N/A</Badge>;

  if (code >= 200 && code < 300) {
    return <Badge className="bg-green-700 text-white hover:bg-green-800">{code}</Badge>;
  }
  if (code >= 400 && code < 500) {
    return <Badge className="bg-yellow-600 text-white hover:bg-yellow-700">{code}</Badge>;
  }
  if (code >= 500) {
    return <Badge className="bg-red-700 text-white hover:bg-red-800">{code}</Badge>;
  }
  return <Badge variant="outline">{code}</Badge>;
}

function SortableHeader({
  label,
  column,
  currentSortBy,
  currentSortOrder,
  onSort,
}: {
  label: string;
  column: SortBy;
  currentSortBy: SortBy;
  currentSortOrder: SortOrder;
  onSort: (column: SortBy) => void;
}) {
  const isActive = currentSortBy === column;
  return (
    <TableHead
      className="hover:bg-muted/50 cursor-pointer select-none"
      onClick={() => onSort(column)}
    >
      <div className="flex items-center gap-1">
        {label}
        {isActive ? (
          currentSortOrder === 'asc' ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )
        ) : (
          <ChevronDown className="h-4 w-4 opacity-30" />
        )}
      </div>
    </TableHead>
  );
}

function RequestLogDetailDialog({
  log,
  open,
  onOpenChange,
}: {
  log: RequestLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  if (!log) return null;

  const parsedRequest = typeof log.request === 'string' ? tryParseJson(log.request) : log.request;
  const parsedResponse = tryParseJson(log.response);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request Log #{log.id}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={viewMode === 'formatted' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('formatted')}
            >
              Formatted
            </Button>
            <Button
              variant={viewMode === 'raw' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('raw')}
            >
              Raw JSON
            </Button>
          </div>

          {viewMode === 'formatted' ? (
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">ID:</span> {log.id}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Created:</span>{' '}
                    {format(new Date(log.created_at), 'yyyy-MM-dd HH:mm:ss')}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Provider:</span> {log.provider ?? 'N/A'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Model:</span> {log.model ?? 'N/A'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status:</span>{' '}
                    <StatusBadge code={log.status_code} />
                  </div>
                  <div>
                    <span className="text-muted-foreground">User ID:</span>{' '}
                    {log.kilo_user_id ?? 'N/A'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Org ID:</span>{' '}
                    {log.organization_id ?? 'N/A'}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Request</CardTitle>
                </CardHeader>
                <CardContent>
                  {parsedRequest && typeof parsedRequest === 'object' ? (
                    <div className="max-h-60 overflow-auto rounded text-xs">
                      <JsonView value={parsedRequest} style={darkTheme} collapsed={2} />
                    </div>
                  ) : (
                    <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">
                      {JSON.stringify(log.request, null, 2)}
                    </pre>
                  )}
                </CardContent>
              </Card>

              <Card className="col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Response</CardTitle>
                </CardHeader>
                <CardContent>
                  {parsedResponse && typeof parsedResponse === 'object' ? (
                    <div className="max-h-80 overflow-auto rounded text-xs">
                      <JsonView value={parsedResponse} style={darkTheme} collapsed={2} />
                    </div>
                  ) : (
                    <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
                      {log.response ?? 'No response'}
                    </pre>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Full Request</CardTitle>
                </CardHeader>
                <CardContent>
                  {parsedRequest && typeof parsedRequest === 'object' ? (
                    <div className="max-h-80 overflow-auto rounded text-xs">
                      <JsonView value={parsedRequest} style={darkTheme} />
                    </div>
                  ) : (
                    <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
                      {JSON.stringify(log.request, null, 2)}
                    </pre>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Full Response</CardTitle>
                </CardHeader>
                <CardContent>
                  {parsedResponse && typeof parsedResponse === 'object' ? (
                    <div className="max-h-80 overflow-auto rounded text-xs">
                      <JsonView value={parsedResponse} style={darkTheme} />
                    </div>
                  ) : (
                    <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
                      {log.response ?? 'No response'}
                    </pre>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RequestLogsTable() {
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [sortBy, setSortBy] = useState<SortBy>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(filters.search);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const queryParams = useMemo(() => {
    const params: Parameters<typeof useRequestLogsList>[0] = {
      page,
      limit,
      sortBy,
      sortOrder,
    };

    if (filters.requestId) params.requestId = filters.requestId;
    if (debouncedSearch) params.search = debouncedSearch;
    if (filters.fromDate) params.fromDate = new Date(filters.fromDate).toISOString();
    if (filters.toDate) params.toDate = new Date(filters.toDate).toISOString();
    if (filters.provider) params.provider = filters.provider;
    if (filters.model) params.model = filters.model;
    if (filters.statusCode) {
      const parsed = parseInt(filters.statusCode, 10);
      if (!isNaN(parsed)) params.statusCode = parsed;
    }
    if (filters.kiloUserId) params.kiloUserId = filters.kiloUserId;
    if (filters.organizationId) params.organizationId = filters.organizationId;

    return params;
  }, [page, limit, sortBy, sortOrder, filters, debouncedSearch]);

  const { data, isLoading } = useRequestLogsList(queryParams);

  const handleSort = useCallback(
    (column: SortBy) => {
      if (sortBy === column) {
        setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortBy(column);
        setSortOrder('desc');
      }
      setPage(1);
    },
    [sortBy]
  );

  const updateFilter = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    if (key !== 'search') setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(emptyFilters);
    setDebouncedSearch('');
    setPage(1);
  }, []);

  const handleViewLog = useCallback((log: RequestLog) => {
    setSelectedLog(log);
    setDialogOpen(true);
  }, []);

  const hasActiveFilters = Object.values(filters).some(v => v !== '');

  const logs = data?.logs ?? [];
  const pagination = data?.pagination ?? { page: 1, limit: 50, total: 0, totalPages: 0 };

  return (
    <div className="w-full space-y-4">
      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Search className="h-4 w-4" />
              Filters
            </CardTitle>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />
                Clear filters
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="requestId">Request ID</Label>
              <Input
                id="requestId"
                placeholder="Exact ID match"
                value={filters.requestId}
                onChange={e => updateFilter('requestId', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="search">Full-text Search</Label>
              <Input
                id="search"
                placeholder="Search provider, model, user, request..."
                value={filters.search}
                onChange={e => updateFilter('search', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fromDate">From Date</Label>
              <Input
                id="fromDate"
                type="datetime-local"
                value={filters.fromDate}
                onChange={e => updateFilter('fromDate', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toDate">To Date</Label>
              <Input
                id="toDate"
                type="datetime-local"
                value={filters.toDate}
                onChange={e => updateFilter('toDate', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="provider">Provider</Label>
              <Input
                id="provider"
                placeholder="e.g. openai"
                value={filters.provider}
                onChange={e => updateFilter('provider', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                placeholder="e.g. gpt-4"
                value={filters.model}
                onChange={e => updateFilter('model', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="statusCode">Status Code</Label>
              <Input
                id="statusCode"
                type="number"
                placeholder="e.g. 200"
                value={filters.statusCode}
                onChange={e => updateFilter('statusCode', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kiloUserId">User ID</Label>
              <Input
                id="kiloUserId"
                placeholder="Kilo user ID"
                value={filters.kiloUserId}
                onChange={e => updateFilter('kiloUserId', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="organizationId">Organization ID</Label>
              <Input
                id="organizationId"
                placeholder="Organization ID"
                value={filters.organizationId}
                onChange={e => updateFilter('organizationId', e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <SortableHeader
                  label="Created At"
                  column="created_at"
                  currentSortBy={sortBy}
                  currentSortOrder={sortOrder}
                  onSort={handleSort}
                />
                <TableHead>User ID</TableHead>
                <TableHead>Org ID</TableHead>
                <SortableHeader
                  label="Provider"
                  column="provider"
                  currentSortBy={sortBy}
                  currentSortOrder={sortOrder}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="Model"
                  column="model"
                  currentSortBy={sortBy}
                  currentSortOrder={sortOrder}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="Status"
                  column="status_code"
                  currentSortBy={sortBy}
                  currentSortOrder={sortOrder}
                  onSort={handleSort}
                />
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
                    No request logs found
                  </TableCell>
                </TableRow>
              ) : (
                logs.map(log => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-xs">{log.id}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {format(new Date(log.created_at), 'yyyy-MM-dd HH:mm:ss')}
                    </TableCell>
                    <TableCell className="max-w-32 truncate text-xs">
                      {log.kilo_user_id ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-32 truncate text-xs">
                      {log.organization_id ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">{log.provider ?? '—'}</TableCell>
                    <TableCell className="max-w-40 truncate text-xs">{log.model ?? '—'}</TableCell>
                    <TableCell>
                      <StatusBadge code={log.status_code} />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => handleViewLog(log)}>
                        <Eye className="mr-1 h-4 w-4" />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between px-2">
        <div className="text-muted-foreground text-sm">
          {pagination.total > 0
            ? `Showing ${(pagination.page - 1) * pagination.limit + 1}–${Math.min(
                pagination.page * pagination.limit,
                pagination.total
              )} of ${pagination.total}`
            : 'No results'}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">
            Page {pagination.page} of {pagination.totalPages || 1}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(prev => prev - 1)}
              disabled={pagination.page <= 1 || isLoading}
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(prev => prev + 1)}
              disabled={pagination.page >= pagination.totalPages || isLoading}
            >
              Next
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Detail Dialog */}
      <RequestLogDetailDialog log={selectedLog} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
