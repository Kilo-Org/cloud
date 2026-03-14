'use client';

import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbLink } from '@/components/ui/breadcrumb';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  AreaChart,
  Area,
} from 'recharts';
import Link from 'next/link';
import {
  useGastownOverview,
  useGastownEventsTimeseries,
  useGastownErrorRates,
  useGastownTopUsers,
  useGastownLatencyByEvent,
  useGastownDeliveryBreakdown,
  type EventTimeseriesRow,
  type DeliveryBreakdownRow,
} from '../api/gastown-analytics/hooks';

// Color palette for chart series
const COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#ca8a04',
  '#9333ea',
  '#0891b2',
  '#e11d48',
  '#65a30d',
  '#c026d3',
  '#ea580c',
  '#0284c7',
  '#4f46e5',
  '#059669',
  '#d97706',
  '#7c3aed',
];

const DELIVERY_COLORS: Record<string, string> = {
  http: '#2563eb',
  trpc: '#16a34a',
  internal: '#ca8a04',
};

function formatHour(ts: string): string {
  try {
    return format(parseISO(ts), 'MM/dd HH:mm');
  } catch {
    return ts;
  }
}

function formatLatency(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// ── Pivot timeseries data for recharts ───────────────────────────────

/** Pivot rows [{hour, event, count}] into [{hour, eventA: 5, eventB: 3}], keeping only the top N events by total volume */
function pivotTimeseries(
  rows: EventTimeseriesRow[],
  topN = 15
): { data: Record<string, unknown>[]; events: string[] } {
  // Sum totals per event to determine the top N
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.event, (totals.get(row.event) ?? 0) + Number(row.count));
  }
  const topEvents = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([event]) => event)
  );

  const byHour = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!topEvents.has(row.event)) continue;
    let entry = byHour.get(row.hour);
    if (!entry) {
      entry = { hour: row.hour };
      byHour.set(row.hour, entry);
    }
    entry[row.event] = Number(row.count);
  }

  const events = [...topEvents];
  const data = [...byHour.values()].sort((a, b) => String(a.hour).localeCompare(String(b.hour)));
  return { data, events };
}

function pivotDeliveryBreakdown(rows: DeliveryBreakdownRow[]): {
  data: Record<string, unknown>[];
  deliveries: string[];
} {
  const deliverySet = new Set<string>();
  const byHour = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    deliverySet.add(row.delivery);
    let entry = byHour.get(row.hour);
    if (!entry) {
      entry = { hour: row.hour };
      byHour.set(row.hour, entry);
    }
    entry[row.delivery] = Number(row.count);
  }

  const deliveries = [...deliverySet];
  const data = [...byHour.values()].sort((a, b) => String(a.hour).localeCompare(String(b.hour)));
  return { data, deliveries };
}

// ── Components ───────────────────────────────────────────────────────

function LoadingCard({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-muted-foreground flex h-48 items-center justify-center">
          Loading...
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ title, error }: { title: string; error: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-destructive flex h-48 items-center justify-center">{error}</div>
      </CardContent>
    </Card>
  );
}

function OverviewCards({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownOverview(hours);
  if (isLoading) return <LoadingCard title="Overview" />;
  if (error) return <ErrorCard title="Overview" error={error.message} />;
  const row = data?.data?.[0];
  if (!row) return <ErrorCard title="Overview" error="No data" />;

  const errorRate =
    row.total_events > 0 ? ((row.error_count / row.total_events) * 100).toFixed(1) : '0';

  const stats = [
    { label: 'Total Events', value: formatCount(row.total_events) },
    { label: 'Unique Users', value: String(row.unique_users) },
    { label: 'Avg Latency', value: formatLatency(row.avg_latency_ms) },
    { label: 'Error Rate', value: `${errorRate}%`, sub: `${formatCount(row.error_count)} errors` },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {stats.map(s => (
        <Card key={s.label}>
          <CardHeader className="pb-2">
            <CardDescription>{s.label}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{s.value}</div>
            {s.sub && <p className="text-muted-foreground text-xs">{s.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EventsTimeseriesChart({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownEventsTimeseries(hours);
  if (isLoading) return <LoadingCard title="Events Over Time" />;
  if (error) return <ErrorCard title="Events Over Time" error={error.message} />;

  const { data: chartData, events } = pivotTimeseries(data?.data ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Events Over Time</CardTitle>
        <CardDescription>Top 15 events by volume, hourly</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="hour" tickFormatter={formatHour} className="text-xs" />
            <YAxis className="text-xs" />
            <Tooltip
              labelFormatter={formatHour}
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
              }}
            />
            <Legend />
            {events.map((event, i) => (
              <Area
                key={event}
                type="monotone"
                dataKey={event}
                stackId="1"
                fill={COLORS[i % COLORS.length]}
                stroke={COLORS[i % COLORS.length]}
                fillOpacity={0.6}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function ErrorRatesChart({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownErrorRates(hours);
  if (isLoading) return <LoadingCard title="Success vs Error Rates" />;
  if (error) return <ErrorCard title="Success vs Error Rates" error={error.message} />;

  const chartData = (data?.data ?? []).map(row => ({
    event: row.event,
    success: Number(row.success_count),
    errors: Number(row.error_count),
    errorRate:
      row.total > 0 ? Number(((Number(row.error_count) / Number(row.total)) * 100).toFixed(1)) : 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Success vs Error Rates</CardTitle>
        <CardDescription>By event type (top 30 by volume)</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(400, chartData.length * 28)}>
          <ComposedChart layout="vertical" data={chartData} margin={{ left: 140, right: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis xAxisId="count" type="number" className="text-xs" orientation="bottom" />
            <XAxis
              xAxisId="pct"
              type="number"
              className="text-xs"
              orientation="top"
              domain={[0, 100]}
              unit="%"
              hide
            />
            <YAxis
              dataKey="event"
              type="category"
              width={130}
              className="text-xs"
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
              }}
            />
            <Legend />
            <Bar xAxisId="count" dataKey="success" stackId="a" fill="#16a34a" name="Success" />
            <Bar xAxisId="count" dataKey="errors" stackId="a" fill="#dc2626" name="Errors" />
            <Line xAxisId="pct" dataKey="errorRate" stroke="#f59e0b" name="Error %" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function DeliveryBreakdownChart({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownDeliveryBreakdown(hours);
  if (isLoading) return <LoadingCard title="Delivery Breakdown" />;
  if (error) return <ErrorCard title="Delivery Breakdown" error={error.message} />;

  const { data: chartData, deliveries } = pivotDeliveryBreakdown(data?.data ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery Breakdown</CardTitle>
        <CardDescription>
          Events by delivery type (HTTP / tRPC / Internal) over time
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="hour" tickFormatter={formatHour} className="text-xs" />
            <YAxis className="text-xs" />
            <Tooltip
              labelFormatter={formatHour}
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
              }}
            />
            <Legend />
            {deliveries.map(d => (
              <Bar key={d} dataKey={d} stackId="a" fill={DELIVERY_COLORS[d] ?? '#6b7280'} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function LatencyTable({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownLatencyByEvent(hours);
  if (isLoading) return <LoadingCard title="Latency by Event" />;
  if (error) return <ErrorCard title="Latency by Event" error={error.message} />;

  const rows = data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Latency by Event</CardTitle>
        <CardDescription>Average response time for HTTP and tRPC operations</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead className="text-right">Avg Latency</TableHead>
              <TableHead className="text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={`${row.event}-${row.delivery}-${i}`}>
                <TableCell className="font-mono text-sm">{row.event}</TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.delivery === 'http'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                        : row.delivery === 'trpc'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                    }`}
                  >
                    {row.delivery}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono">
                  <span className={Number(row.avg_latency_ms) > 1000 ? 'text-red-500' : ''}>
                    {formatLatency(Number(row.avg_latency_ms))}
                  </span>
                </TableCell>
                <TableCell className="text-right">{formatCount(Number(row.count))}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-center">
                  No data
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TopUsersTable({ hours }: { hours: number }) {
  const { data, isLoading, error } = useGastownTopUsers(hours);
  if (isLoading) return <LoadingCard title="Top Users" />;
  if (error) return <ErrorCard title="Top Users" error={error.message} />;

  const rows = data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Users</CardTitle>
        <CardDescription>Most active users by event count</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Error Rate</TableHead>
              <TableHead className="text-right">Avg Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => {
              const errorRate =
                Number(row.total_events) > 0
                  ? ((Number(row.error_count) / Number(row.total_events)) * 100).toFixed(1)
                  : '0';
              return (
                <TableRow key={row.user_id}>
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.user_id)}`}
                      className="font-mono text-sm text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {row.user_id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCount(Number(row.total_events))}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={Number(row.error_count) > 0 ? 'text-red-500' : ''}>
                      {formatCount(Number(row.error_count))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={Number(errorRate) > 10 ? 'text-red-500' : ''}>
                      {errorRate}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatLatency(Number(row.avg_latency_ms))}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No data
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function GastownAnalyticsPage() {
  const [hours, setHours] = useState(24);

  return (
    <AdminPage
      breadcrumbs={
        <BreadcrumbItem>
          <BreadcrumbLink href="/admin/gastown">Gastown Analytics</BreadcrumbLink>
        </BreadcrumbItem>
      }
      buttons={
        <Select value={String(hours)} onValueChange={v => setHours(Number(v))}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 1 hour</SelectItem>
            <SelectItem value="6">Last 6 hours</SelectItem>
            <SelectItem value="24">Last 24 hours</SelectItem>
            <SelectItem value="72">Last 3 days</SelectItem>
            <SelectItem value="168">Last 7 days</SelectItem>
            <SelectItem value="720">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      <div className="flex w-full flex-col gap-6">
        <OverviewCards hours={hours} />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <EventsTimeseriesChart hours={hours} />
          <DeliveryBreakdownChart hours={hours} />
        </div>

        <ErrorRatesChart hours={hours} />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <LatencyTable hours={hours} />
          <TopUsersTable hours={hours} />
        </div>
      </div>
    </AdminPage>
  );
}
