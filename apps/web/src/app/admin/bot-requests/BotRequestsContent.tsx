'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { PAGE_SIZE_OPTIONS } from '@/types/pagination';
import type { PageSize, PaginationMetadata } from '@/types/pagination';
import { getPaginationHelpers } from '@/types/pagination';
import {
  useWeeklyActiveUsers,
  useNewUsersPerDay,
  useDailyUsage,
  useBotRequestsList,
} from './hooks';
import { BotRequestStatusBadge } from './BotRequestStatusBadge';

const MESSAGE_PREVIEW_LENGTH = 80;
const DEFAULT_DAYS = 30;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE: PageSize = 25;
const PLATFORM_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#0891b2', '#475569'];

// --- Chart Components ---

type SimpleTooltipProps = {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  valueLabel: string;
};

function SimpleTooltip({ active, payload, label, valueLabel }: SimpleTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background rounded-lg border p-3 shadow-sm">
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">{valueLabel}:</span>{' '}
        <span className="font-medium">{payload[0].value.toLocaleString()}</span>
      </p>
    </div>
  );
}

function ChartSkeleton({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bg-muted h-[300px] w-full animate-pulse rounded" />
      </CardContent>
    </Card>
  );
}

function ChartError({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-destructive">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function formatPlatformLabel(platform: string) {
  return platform
    .split(/[-_]/)
    .map(part => (part.length > 0 ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}` : part))
    .join(' ');
}

function WeeklyActiveUsersChart() {
  const { data, isLoading, error } = useWeeklyActiveUsers(DEFAULT_DAYS);

  if (isLoading) return <ChartSkeleton title="Weekly Active Users" description="Loading..." />;
  if (error) return <ChartError title="Weekly Active Users" message={error.message} />;
  if (!data?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Weekly Active Users</CardTitle>
          <CardDescription>No data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const chartData = data.map(item => ({
    week: format(parseISO(item.week), 'MM/dd'),
    activeUsers: item.activeUsers,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly Active Users</CardTitle>
        <CardDescription>Distinct users per week (based on created_by)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="week"
                angle={-45}
                textAnchor="end"
                height={60}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                className="text-xs"
                tick={{ fontSize: 10 }}
                allowDecimals={false}
                label={{
                  value: 'Users',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<SimpleTooltip valueLabel="Active Users" />} />
              <Bar dataKey="activeUsers" fill="#2563eb" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function NewUsersPerDayChart() {
  const { data, isLoading, error } = useNewUsersPerDay(DEFAULT_DAYS);

  if (isLoading) return <ChartSkeleton title="New Users per Day" description="Loading..." />;
  if (error) return <ChartError title="New Users per Day" message={error.message} />;
  if (!data?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>New Users per Day</CardTitle>
          <CardDescription>No data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const chartData = data.map(item => ({
    date: format(parseISO(item.date), 'MM/dd'),
    newUsers: item.newUsers,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Users per Day</CardTitle>
        <CardDescription>First-time bot users each day</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                angle={-45}
                textAnchor="end"
                height={60}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                className="text-xs"
                tick={{ fontSize: 10 }}
                allowDecimals={false}
                label={{
                  value: 'New Users',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<SimpleTooltip valueLabel="New Users" />} />
              <Bar dataKey="newUsers" fill="#16a34a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function DailyUsageChart() {
  const { data, isLoading, error } = useDailyUsage(DEFAULT_DAYS);

  if (isLoading) return <ChartSkeleton title="Daily Usage" description="Loading..." />;
  if (error) return <ChartError title="Daily Usage" message={error.message} />;
  if (!data?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Daily Usage</CardTitle>
          <CardDescription>No data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const platforms = [...new Set(data.map(item => item.platform))].sort();
  const rowsByDate = new Map<string, Record<string, number | string>>();

  for (const item of data) {
    const formattedDate = format(parseISO(item.date), 'MM/dd');
    let row = rowsByDate.get(formattedDate);

    if (!row) {
      row = { date: formattedDate };

      for (const platform of platforms) {
        row[platform] = 0;
      }

      rowsByDate.set(formattedDate, row);
    }

    row[item.platform] = item.totalRequests;
  }

  const chartData = Array.from(rowsByDate.values());

  type PlatformTooltipProps = {
    active?: boolean;
    payload?: Array<{ dataKey?: string; value?: number; color?: string }>;
    label?: string;
  };

  const PlatformTooltip = ({ active, payload, label }: PlatformTooltipProps) => {
    if (!active || !payload?.length) return null;

    const series = payload.filter(
      item => typeof item.dataKey === 'string' && typeof item.value === 'number' && item.value > 0
    );

    if (series.length === 0) return null;

    const total = series.reduce((sum, item) => sum + (item.value ?? 0), 0);

    return (
      <div className="bg-background rounded-lg border p-3 shadow-sm">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-2 space-y-1">
          {series.map(item => (
            <p key={item.dataKey} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-muted-foreground">
                  {formatPlatformLabel(item.dataKey ?? 'Unknown')}
                </span>
              </span>
              <span className="font-medium">{item.value?.toLocaleString()}</span>
            </p>
          ))}
          <p className="flex items-center justify-between gap-3 border-t pt-2 text-sm font-medium">
            <span>Total</span>
            <span>{total.toLocaleString()}</span>
          </p>
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Usage by Platform</CardTitle>
        <CardDescription>Total bot requests per day, stacked by platform</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                angle={-45}
                textAnchor="end"
                height={60}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                className="text-xs"
                tick={{ fontSize: 10 }}
                allowDecimals={false}
                label={{
                  value: 'Requests',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<PlatformTooltip />} />
              <Legend />
              {platforms.map((platform, index) => (
                <Bar
                  key={platform}
                  dataKey={platform}
                  stackId="requests"
                  fill={PLATFORM_COLORS[index % PLATFORM_COLORS.length]}
                  name={formatPlatformLabel(platform)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Pagination ---

function RequestsPagination({
  pagination,
  onPageChange,
  onLimitChange,
}: {
  pagination: PaginationMetadata;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: PageSize) => void;
}) {
  const { hasNext, hasPrev } = getPaginationHelpers(pagination);

  return (
    <div className="flex items-center justify-between px-2 py-4">
      <div className="text-muted-foreground text-sm">
        Showing {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)}–
        {Math.min(pagination.page * pagination.limit, pagination.total)} of{' '}
        {pagination.total.toLocaleString()}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Rows per page</span>
          <Select
            value={String(pagination.limit)}
            onValueChange={value => {
              const parsed = Number.parseInt(value, 10);
              const nextLimit =
                PAGE_SIZE_OPTIONS.find(option => option === parsed) ?? DEFAULT_PAGE_SIZE;
              onLimitChange(nextLimit);
            }}
          >
            <SelectTrigger className="w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" disabled={!hasPrev} onClick={() => onPageChange(1)}>
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasPrev}
            onClick={() => onPageChange(pagination.page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground mx-2 text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasNext}
            onClick={() => onPageChange(pagination.page + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasNext}
            onClick={() => onPageChange(pagination.totalPages)}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Requests Table ---

function RequestsTable({
  page,
  limit,
  onPageChange,
  onLimitChange,
}: {
  page: number;
  limit: PageSize;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: PageSize) => void;
}) {
  const router = useRouter();
  const { data, isLoading, error } = useBotRequestsList(page, limit);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
          <CardDescription className="text-destructive">{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const requests = data?.requests ?? [];
  const pagination = data?.pagination ?? { page, limit, total: 0, totalPages: 0 };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Requests</CardTitle>
        <CardDescription>All bot requests, most recent first</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="bg-muted h-4 w-24 animate-pulse rounded" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : requests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-center">
                    No requests found
                  </TableCell>
                </TableRow>
              ) : (
                requests.map(row => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/bot-requests/${row.id}`)}
                  >
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{row.userEmail}</span>
                        <span className="text-muted-foreground text-xs">{row.userName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.organizationName ?? <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate text-sm" title={row.userMessage}>
                      {row.userMessage.length > MESSAGE_PREVIEW_LENGTH
                        ? `${row.userMessage.slice(0, MESSAGE_PREVIEW_LENGTH)}...`
                        : row.userMessage}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.platform}</Badge>
                    </TableCell>
                    <TableCell>
                      <BotRequestStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {format(parseISO(row.createdAt), 'MMM d, HH:mm')}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {pagination.total > 0 && (
          <RequestsPagination
            pagination={pagination}
            onPageChange={onPageChange}
            onLimitChange={onLimitChange}
          />
        )}
      </CardContent>
    </Card>
  );
}

// --- Main Content ---

export function BotRequestsContent() {
  const [page, setPage] = useState(DEFAULT_PAGE);
  const [limit, setLimit] = useState<PageSize>(DEFAULT_PAGE_SIZE);

  const handleLimitChange = useCallback((newLimit: PageSize) => {
    setLimit(newLimit);
    setPage(1);
  }, []);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <h2 className="text-2xl font-bold">Bot Requests</h2>

      <div className="grid gap-6 lg:grid-cols-2">
        <WeeklyActiveUsersChart />
        <NewUsersPerDayChart />
      </div>

      <DailyUsageChart />

      <RequestsTable
        page={page}
        limit={limit}
        onPageChange={setPage}
        onLimitChange={handleLimitChange}
      />
    </div>
  );
}
