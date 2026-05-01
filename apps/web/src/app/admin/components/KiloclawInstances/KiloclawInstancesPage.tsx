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
import { Checkbox } from '@/components/ui/checkbox';
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
import { ChevronLeft, ChevronRight, Info, X, Bomb } from 'lucide-react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import { BulkChangeVersionDialog } from './BulkChangeVersionDialog';
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
import { formatRelativeTime } from './shared';

type SortField = 'created_at' | 'destroyed_at';
type SortOrder = 'asc' | 'desc';
type StatusFilter = 'all' | 'active' | 'inactive_trial_stopped' | 'suspended' | 'destroyed';

/**
 * Sentinel value for the version filter that matches rows whose
 * `tracked_image_tag` is null (alarm hasn't ticked / hibernated DOs).
 * Must match the backend constant in admin-kiloclaw-instances-router.ts.
 */
const IMAGE_TAG_FILTER_UNKNOWN = '__unknown__';
const IMAGE_TAG_FILTER_ALL = '__all__';

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
  inactiveTrialStoppedInstances: number;
  suspendedInstances: number;
  destroyedInstances: number;
  uniqueUsers: number;
  last24hCreated: number;
  last7dCreated: number;
  activeUsers7d: number;
  avgLifespanMinutes: number | null;
};

function StatPill({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col gap-0.5">
      <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">
        {label}
      </span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

function OverviewStatsCards({ data }: { data: OverviewData }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap gap-x-8 gap-y-4 py-4">
        <StatPill
          label="Total"
          value={data.totalInstances.toLocaleString()}
          hint={`+${data.last24hCreated} 24h · +${data.last7dCreated} 7d`}
        />
        <StatPill
          label="Active"
          value={data.activeInstances.toLocaleString()}
          hint={`${data.destroyedInstances.toLocaleString()} destroyed`}
        />
        <StatPill
          label="Inactive trial"
          value={data.inactiveTrialStoppedInstances.toLocaleString()}
        />
        <StatPill label="Suspended" value={data.suspendedInstances.toLocaleString()} />
        <StatPill
          label="Unique users"
          value={data.uniqueUsers.toLocaleString()}
          hint={`${data.activeUsers7d} active 7d`}
        />
        <StatPill label="Avg lifespan" value={formatLifespan(data.avgLifespanMinutes)} />
      </CardContent>
    </Card>
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
      <CardHeader className="flex flex-row items-baseline justify-between gap-4 space-y-0 py-3">
        <div className="flex items-baseline gap-3">
          <CardTitle className="text-sm font-medium">Daily Instances</CardTitle>
          <CardDescription className="text-xs">
            Created and destroyed per day (last 30 days)
          </CardDescription>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5"
            onClick={() => setShowCreated(prev => !prev)}
          >
            <div
              className={`h-2.5 w-2.5 rounded-sm bg-green-500 transition-opacity ${showCreated ? 'opacity-100' : 'opacity-30'}`}
            />
            <span
              className={`text-muted-foreground transition-opacity ${showCreated ? 'opacity-100' : 'line-through opacity-50'}`}
            >
              Created
            </span>
          </button>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5"
            onClick={() => setShowDestroyed(prev => !prev)}
          >
            <div
              className={`h-2.5 w-2.5 rounded-sm bg-red-500 transition-opacity ${showDestroyed ? 'opacity-100' : 'opacity-30'}`}
            />
            <span
              className={`text-muted-foreground transition-opacity ${showDestroyed ? 'opacity-100' : 'line-through opacity-50'}`}
            >
              Destroyed
            </span>
          </button>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="h-[140px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={24}
                tick={{ fontSize: 10 }}
              />
              <YAxis domain={[0, yAxisMax]} width={28} tick={{ fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              {showCreated && <Bar dataKey="created" fill="#22c55e" name="Created" />}
              {showDestroyed && <Bar dataKey="destroyed" fill="#ef4444" name="Destroyed" />}
            </ComposedChart>
          </ResponsiveContainer>
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
      imageTag: searchParams.get('imageTag') || '',
    }),
    [searchParams]
  );

  const [searchInput, setSearchInput] = useState(queryStringState.search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);

  const offset = (queryStringState.page - 1) * queryStringState.limit;

  const { data, isLoading, error, isFetching } = useQuery(
    trpc.admin.kiloclawInstances.list.queryOptions({
      offset,
      limit: queryStringState.limit,
      sortBy: queryStringState.sortBy,
      sortOrder: queryStringState.sortOrder,
      search: queryStringState.search,
      status: queryStringState.status,
      imageTag: queryStringState.imageTag || undefined,
    })
  );

  const { data: statsData } = useQuery(
    trpc.admin.kiloclawInstances.stats.queryOptions({ days: 30 })
  );

  // Populates the version filter dropdown. Same call the single-instance
  // "Change version…" dialog uses on KiloclawInstanceDetail.
  const { data: versionsData } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({
      status: 'available',
      limit: 100,
    })
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

  const handleImageTagChange = useCallback(
    (value: string) => {
      // The Select uses sentinel values for "All" and "(unknown)" because
      // shadcn's Select rejects empty-string values.
      const next = value === IMAGE_TAG_FILTER_ALL ? '' : value;
      pushWith({ imageTag: next, page: 1 });
    },
    [pushWith]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

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

  const versions = versionsData?.items || [];

  const allVisibleSelected = instances.length > 0 && instances.every(i => selectedIds.has(i.id));
  const someVisibleSelected = !allVisibleSelected && instances.some(i => selectedIds.has(i.id));

  const toggleSelectAllVisible = () => {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const i of instances) next.delete(i.id);
        return next;
      }
      const next = new Set(prev);
      for (const i of instances) next.add(i.id);
      return next;
    });
  };

  // Selection persists across filter/sort/pagination changes. Show a hint
  // when some selected ids are not in the current page so admins don't lose
  // track of work-in-flight.
  const visibleSelectedCount = instances.reduce((n, i) => (selectedIds.has(i.id) ? n + 1 : n), 0);
  const offscreenSelectedCount = selectedIds.size - visibleSelectedCount;

  // The bulk dialog needs the full row data (tracked_image_tag, pin, etc.)
  // for its summary panel. We only reliably have rows for the current page,
  // so the dialog operates on the intersection of selectedIds × instances.
  const selectedInstances = instances.filter(i => selectedIds.has(i.id));

  // Map image_tag → openclaw_version so the Version column can pair the
  // technical image tag with its human-meaningful semver. Built from the
  // already-fetched listVersions data so this costs nothing extra. Tags
  // not in the active catalog (e.g. disabled or removed) fall back to
  // just the image_tag.
  const openclawVersionByImageTag = useMemo(
    () => new Map(versions.map(v => [v.image_tag, v.openclaw_version])),
    [versions]
  );

  return (
    <div className="flex w-full flex-col gap-y-6">
      {/* Dashboard Section */}
      {statsData && (
        <div className="space-y-4">
          <OverviewStatsCards data={statsData.overview} />
          {statsData.dailyChart.length > 0 && <DailyChart data={statsData.dailyChart} />}
        </div>
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
          <Button type="submit" variant="secondary" disabled={isFetching}>
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
            <SelectItem value="inactive_trial_stopped">Inactive Trial Stopped</SelectItem>
            <SelectItem value="suspended">Suspended Only</SelectItem>
            <SelectItem value="destroyed">Destroyed Only</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={queryStringState.imageTag || IMAGE_TAG_FILTER_ALL}
          onValueChange={handleImageTagChange}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Version" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={IMAGE_TAG_FILTER_ALL}>All Versions</SelectItem>
            <SelectItem value={IMAGE_TAG_FILTER_UNKNOWN}>(unknown)</SelectItem>
            {versions.map(v => (
              <SelectItem
                key={v.image_tag}
                value={v.image_tag}
                textValue={`${v.openclaw_version} ${v.image_tag}${v.is_latest ? ' (latest)' : ''}`}
              >
                <span className="font-medium">{v.openclaw_version}</span>
                <span className="text-muted-foreground ml-2 font-mono text-xs">{v.image_tag}</span>
                {v.is_latest && (
                  <span className="text-muted-foreground ml-2 text-xs">(latest)</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DevNukeAllButton />
      </div>

      {/* Bulk action bar — always rendered so the affordance is discoverable.
          Empty state shows a muted hint; active state shows count + buttons.
          Mirrors the pattern on KiloclawVersionsPage. */}
      {selectedIds.size === 0 ? (
        <div className="text-muted-foreground border-border/60 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
          <Info className="h-3 w-3 opacity-60" />
          <span>Use the checkboxes to select rows for bulk version changes.</span>
        </div>
      ) : (
        <div className="bg-muted/30 flex items-center gap-3 rounded-md border px-3 py-2">
          <span className="text-sm">
            <span className="font-medium">{selectedIds.size}</span> selected
            {offscreenSelectedCount > 0 && (
              <span className="text-muted-foreground ml-2">
                ({offscreenSelectedCount} not visible on this page)
              </span>
            )}
          </span>
          <Button size="sm" onClick={() => setBulkDialogOpen(true)}>
            Change version…
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={
                    allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false
                  }
                  onCheckedChange={toggleSelectAllVisible}
                  aria-label="Select all visible instances"
                />
              </TableHead>
              <TableHead>User</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Pin</TableHead>
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
              <TableHead>Sandbox ID</TableHead>
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
                <TableCell colSpan={9} className="h-24 text-center">
                  Loading instances...
                </TableCell>
              </TableRow>
            ) : instances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">
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
                  <TableCell
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selectedIds.has(instance.id)}
                      onCheckedChange={() => toggleSelect(instance.id)}
                      aria-label={`Select instance ${instance.sandbox_id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(instance.user_id)}`}
                      className="text-blue-600 hover:underline"
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      {instance.user_email || instance.user_id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    {instance.tracked_image_tag ? (
                      <div className="flex flex-col" title={instance.tracked_image_tag}>
                        {openclawVersionByImageTag.get(instance.tracked_image_tag) && (
                          <span className="font-medium">
                            {openclawVersionByImageTag.get(instance.tracked_image_tag)}
                          </span>
                        )}
                        <span className="text-muted-foreground font-mono">
                          {instance.tracked_image_tag}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">(unknown)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {instance.pin ? (
                      <Badge
                        variant="outline"
                        className={
                          instance.pin.is_admin_pin
                            ? 'border-transparent bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/20'
                            : 'border-transparent bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/20'
                        }
                        title={`Pinned to ${instance.pin.image_tag} by ${
                          instance.pin.is_admin_pin ? 'admin' : 'user'
                        }`}
                      >
                        {instance.pin.is_admin_pin ? 'Admin pin' : 'User pin'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
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
                    {instance.lifecycle_state === 'destroyed' ? (
                      <Badge variant="secondary">Destroyed</Badge>
                    ) : instance.lifecycle_state === 'suspended' ? (
                      <Badge className="bg-amber-600">Suspended</Badge>
                    ) : instance.lifecycle_state === 'inactive_trial_stopped' ? (
                      <Badge className="bg-sky-700">Inactive Trial Stopped</Badge>
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
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    <span
                      className="block truncate"
                      style={{ maxWidth: '110px' }}
                      title={instance.sandbox_id}
                    >
                      {instance.sandbox_id}
                    </span>
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

      <BulkChangeVersionDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        selectedIds={Array.from(selectedIds)}
        visibleSelectedInstances={selectedInstances}
        availableVersions={versions}
        onApplied={() => {
          clearSelection();
        }}
      />
    </div>
  );
}
