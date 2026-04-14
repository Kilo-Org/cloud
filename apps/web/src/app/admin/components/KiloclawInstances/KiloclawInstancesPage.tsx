'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChevronLeft, ChevronRight, X, Bomb } from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow, format, parseISO } from 'date-fns';
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';

type SortField = 'created_at' | 'destroyed_at';
type SortOrder = 'asc' | 'desc';
type StatusFilter = 'all' | 'active' | 'suspended' | 'destroyed';

const subscriptionBadgeClass: Record<KiloClawSubscriptionStatus, string> = {
  active: 'border-green-500/30 bg-green-500/15 text-green-400',
  trialing: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  past_due: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  canceled: 'border-red-500/30 bg-red-500/15 text-red-400',
  unpaid: 'border-red-500/30 bg-red-500/15 text-red-400',
};

function toSortedSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value) params.set(key, String(value));
  }
  return params;
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return '—';
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

function formatLifespan(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// --- Overview Stats Cards ---

type OverviewData = {
  totalInstances: number;
  activeInstances: number;
  suspendedInstances: number;
  destroyedInstances: number;
  uniqueUsers: number;
  last24hCreated: number;
  last7dCreated: number;
  activeUsers7d: number;
  avgLifespanMinutes: number | null;
};

function OverviewStatsCards({ data }: { data: OverviewData }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Total Instances</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.totalInstances.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">
            {data.last24hCreated} last 24h &middot; {data.last7dCreated} last 7d
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Active Instances</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.activeInstances.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">
            {data.destroyedInstances.toLocaleString()} destroyed
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Suspended Instances</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.suspendedInstances.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">Suspended by billing lifecycle</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Unique Users</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.uniqueUsers.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">{data.activeUsers7d} active in last 7d</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Avg Lifespan</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatLifespan(data.avgLifespanMinutes)}</div>
          <p className="text-muted-foreground text-xs">Average time before destroyed</p>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Daily Chart ---

type DailyChartData = {
  date: string;
  created: number;
  destroyed: number;
};

type TooltipPayload = {
  dataKey: string;
  value: number;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
};

function DailyChart({ data }: { data: DailyChartData[] }) {
  const [showCreated, setShowCreated] = useState(true);
  const [showDestroyed, setShowDestroyed] = useState(true);

  const chartData = data.map(item => ({
    date: format(parseISO(item.date), 'MM/dd'),
    created: item.created,
    destroyed: item.destroyed,
  }));

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length) {
      const created = payload.find(p => p.dataKey === 'created')?.value || 0;
      const destroyed = payload.find(p => p.dataKey === 'destroyed')?.value || 0;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            {showCreated && (
              <p className="text-sm">
                <span className="text-muted-foreground">Created:</span>{' '}
                <span className="font-medium">{created}</span>
              </p>
            )}
            {showDestroyed && (
              <p className="text-sm">
                <span className="text-muted-foreground">Destroyed:</span>{' '}
                <span className="font-medium">{destroyed}</span>
              </p>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  const maxVal = Math.max(
    ...chartData.map(d => {
      const vals: number[] = [];
      if (showCreated) vals.push(d.created);
      if (showDestroyed) vals.push(d.destroyed);
      return vals.length > 0 ? Math.max(...vals) : 0;
    }),
    1
  );
  const yAxisMax = Math.ceil(maxVal * 1.1) || 10;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Instances</CardTitle>
        <CardDescription>Instances created and destroyed per day (last 30 days)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                angle={-45}
                textAnchor="end"
                height={60}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis domain={[0, yAxisMax]} tick={{ fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              {showCreated && <Bar dataKey="created" fill="#22c55e" name="Created" />}
              {showDestroyed && <Bar dataKey="destroyed" fill="#ef4444" name="Destroyed" />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 flex items-center justify-center gap-6 text-sm">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2"
            onClick={() => setShowCreated(prev => !prev)}
          >
            <div
              className={`h-3 w-3 rounded-sm bg-green-500 transition-opacity ${showCreated ? 'opacity-100' : 'opacity-30'}`}
            />
            <span
              className={`text-muted-foreground transition-opacity ${showCreated ? 'opacity-100' : 'line-through opacity-50'}`}
            >
              Created
            </span>
          </button>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2"
            onClick={() => setShowDestroyed(prev => !prev)}
          >
            <div
              className={`h-3 w-3 rounded-sm bg-red-500 transition-opacity ${showDestroyed ? 'opacity-100' : 'opacity-30'}`}
            />
            <span
              className={`text-muted-foreground transition-opacity ${showDestroyed ? 'opacity-100' : 'line-through opacity-50'}`}
            >
              Destroyed
            </span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Dev Nuke All Button ---

function DevNukeAllButton() {
  if (process.env.NODE_ENV !== 'development') return null;

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const nukeAll = useMutation(
    trpc.admin.kiloclawInstances.devNukeAll.mutationOptions({
      onSuccess(data) {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.stats.queryKey(),
        });
        const errorSuffix =
          data.errors.length > 0
            ? `\n${data.errors.length} failed:\n${data.errors.map(e => `  ${e.userId}: ${e.error}`).join('\n')}`
            : '';
        alert(`Destroyed ${data.destroyed}/${data.total} instances${errorSuffix}`);
      },
    })
  );

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)} disabled={nukeAll.isPending}>
        <Bomb className="mr-2 h-4 w-4" />
        {nukeAll.isPending ? 'Nuking...' : 'Nuke All'}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Nuke all KiloClaw instances?</AlertDialogTitle>
            <AlertDialogDescription>
              This will destroy every active KiloClaw instance. This action cannot be undone. Only
              available in development mode.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                nukeAll.mutate();
                setOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Nuke All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// --- Main Page ---

export function KiloclawInstancesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useTRPC();

  const queryStringState = useMemo(
    () => ({
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      sortBy: (searchParams.get('sortBy') || 'created_at') as SortField,
      sortOrder: (searchParams.get('sortOrder') || 'desc') as SortOrder,
      search: searchParams.get('search') || '',
      status: (searchParams.get('status') || 'all') as StatusFilter,
    }),
    [searchParams]
  );

  const [searchInput, setSearchInput] = useState(queryStringState.search);

  const offset = (queryStringState.page - 1) * queryStringState.limit;

  const { data, isLoading, error, isFetching } = useQuery(
    trpc.admin.kiloclawInstances.list.queryOptions({
      offset,
      limit: queryStringState.limit,
      sortBy: queryStringState.sortBy,
      sortOrder: queryStringState.sortOrder,
      search: queryStringState.search,
      status: queryStringState.status,
    })
  );

  const { data: statsData } = useQuery(
    trpc.admin.kiloclawInstances.stats.queryOptions({ days: 30 })
  );

  type QueryStringState = typeof queryStringState;

  const pushWith = useCallback(
    (overrides: Partial<QueryStringState>) => {
      const queryString = toSortedSearchParams({
        ...queryStringState,
        ...overrides,
      });
      router.push(`/admin/kiloclaw?${queryString.toString()}`);
    },
    [router, queryStringState]
  );

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      pushWith({ search: searchInput, page: 1 });
    },
    [pushWith, searchInput]
  );

  const handleClearSearch = useCallback(() => {
    setSearchInput('');
    pushWith({ search: '', page: 1 });
  }, [pushWith]);

  const handleStatusChange = useCallback(
    (status: StatusFilter) => {
      pushWith({ status, page: 1 });
    },
    [pushWith]
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newDirection =
        queryStringState.sortBy === field && queryStringState.sortOrder === 'asc' ? 'desc' : 'asc';
      pushWith({ sortBy: field, sortOrder: newDirection, page: 1 });
    },
    [queryStringState.sortBy, queryStringState.sortOrder, pushWith]
  );

  const handlePageChange = useCallback(
    (page: number) => {
      pushWith({ page });
    },
    [pushWith]
  );

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load KiloClaw instances</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const instances = data?.instances || [];
  const pagination = data?.pagination || {
    offset: 0,
    limit: 20,
    total: 0,
    totalPages: 1,
  };

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;

  return (
    <div className="flex w-full flex-col gap-y-6">
      {/* Dashboard Section */}
      {statsData && (
        <>
          <OverviewStatsCards data={statsData.overview} />
          {statsData.dailyChart.length > 0 && <DailyChart data={statsData.dailyChart} />}
        </>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-1 gap-2">
          <div className="relative max-w-md flex-1">
            <Input
              placeholder="Search by user ID, sandbox ID, or instance ID..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pr-8"
            />
            {(searchInput || queryStringState.search) && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Button type="submit" disabled={isFetching}>
            Search
          </Button>
        </form>

        <Select value={queryStringState.status} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Instances</SelectItem>
            <SelectItem value="active">Active Only</SelectItem>
            <SelectItem value="suspended">Suspended Only</SelectItem>
            <SelectItem value="destroyed">Destroyed Only</SelectItem>
          </SelectContent>
        </Select>

        <DevNukeAllButton />
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sandbox ID</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Status</TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('created_at')}
              >
                Created
                {queryStringState.sortBy === 'created_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
              <TableHead
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => handleSort('destroyed_at')}
              >
                Destroyed
                {queryStringState.sortBy === 'destroyed_at' && (
                  <span className="ml-1">{queryStringState.sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  Loading instances...
                </TableCell>
              </TableRow>
            ) : instances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No instances found.
                </TableCell>
              </TableRow>
            ) : (
              instances.map(instance => (
                <TableRow
                  key={instance.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  tabIndex={0}
                  role="link"
                  onClick={() => router.push(`/admin/kiloclaw/${instance.id}`)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      router.push(`/admin/kiloclaw/${instance.id}`);
                    }
                  }}
                >
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(instance.user_id)}`}
                      className="text-blue-600 hover:underline"
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      {instance.user_email || instance.user_id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {instance.organization_id ? (
                      <Badge
                        variant="outline"
                        className="border-blue-500/30 bg-blue-500/15 text-blue-400"
                      >
                        Org
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-gray-500/30 bg-gray-500/10 text-gray-400"
                      >
                        Personal
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    <span
                      className="block truncate"
                      style={{ maxWidth: '200px' }}
                      title={instance.sandbox_id}
                    >
                      {instance.sandbox_id}
                    </span>
                  </TableCell>
                  <TableCell>
                    {instance.subscription_status ? (
                      <Badge
                        variant="outline"
                        className={subscriptionBadgeClass[instance.subscription_status]}
                        title={instance.subscription_id ?? undefined}
                      >
                        {instance.subscription_status}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {instance.destroyed_at !== null ? (
                      <Badge variant="secondary">Destroyed</Badge>
                    ) : instance.suspended_at !== null ? (
                      <Badge className="bg-amber-600">Suspended</Badge>
                    ) : (
                      <Badge variant="default" className="bg-green-600">
                        Active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={new Date(instance.created_at).toLocaleString()}
                  >
                    {formatRelativeTime(instance.created_at)}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={
                      instance.destroyed_at
                        ? new Date(instance.destroyed_at).toLocaleString()
                        : undefined
                    }
                  >
                    {formatRelativeTime(instance.destroyed_at)}
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
          Showing {instances.length > 0 ? pagination.offset + 1 : 0} to{' '}
          {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}{' '}
          instances
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage <= 1 || isFetching}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <div className="text-sm">
            Page {currentPage} of {pagination.totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= pagination.totalPages || isFetching}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
