'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import {
  Activity,
  Clock,
  Hexagon,
  Bot,
  GitMerge,
  AlertTriangle,
  Mail,
  Zap,
  DollarSign,
  FileCode,
} from 'lucide-react';
import { formatDistanceToNow, format, subHours, differenceInMinutes } from 'date-fns';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

type EventTypeCounts = Record<string, number>;
type TimeWindow = '1h' | '6h' | '24h' | '7d';

const WINDOW_OPTIONS: Array<{ value: TimeWindow; label: string }> = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

function formatBucketTime(bucket: string, window: TimeWindow): string {
  const d = new Date(bucket);
  switch (window) {
    case '1h':
      return format(d, 'HH:mm:ss');
    case '6h':
      return format(d, 'HH:mm');
    case '24h':
      return format(d, 'HH:mm');
    case '7d':
      return format(d, 'MMM d HH:mm');
  }
}

function WindowSelector({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] p-0.5">
      {WINDOW_OPTIONS.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            value === opt.value ? 'bg-white/10 text-white/80' : 'text-white/30 hover:text-white/50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ObservabilityPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();
  const [window, setWindow] = useState<TimeWindow>('1h');

  const eventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 500 }),
    refetchInterval: 5_000,
  });

  const metricsQuery = useQuery({
    ...trpc.gastown.getMetricsTimeseries.queryOptions({ townId, window }),
    refetchInterval: window === '1h' ? 5_000 : 15_000,
  });

  const events = eventsQuery.data ?? [];
  const metricsData = metricsQuery.data ?? [];

  // Format timeseries data for charts
  const chartData = useMemo(
    () =>
      metricsData.map(p => ({
        ...p,
        time: formatBucketTime(p.bucket, window),
        total_tokens: p.input_tokens + p.output_tokens,
        cost_dollars: p.cost_microdollars / 1_000_000,
        total_loc: p.loc_additions + p.loc_deletions,
      })),
    [metricsData, window]
  );

  // Event type distribution
  const typeCounts = useMemo(() => {
    const counts: EventTypeCounts = {};
    for (const event of events) {
      counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [events]);

  // Events per hour (last 24h)
  const hourlyData = useMemo(() => {
    const now = new Date();
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const hour = subHours(now, 23 - i);
      return {
        hour: format(hour, 'HH:mm'),
        count: 0,
      };
    });

    for (const event of events) {
      const eventTime = new Date(event.created_at);
      const hoursAgo = differenceInMinutes(now, eventTime) / 60;
      const idx = Math.floor(23 - hoursAgo);
      if (idx >= 0 && idx < 24) {
        buckets[idx].count++;
      }
    }

    return buckets;
  }, [events]);

  // Per-rig event counts
  const rigEventCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const event of events) {
      const rigName = event.rig_name ?? 'unknown';
      counts[rigName] = (counts[rigName] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([rig, count]) => ({ rig, count }))
      .sort((a, b) => b.count - a.count);
  }, [events]);

  const tooltipStyles = {
    contentStyle: {
      background: 'oklch(0.12 0 0)',
      border: '1px solid oklch(1 0 0 / 0.08)',
      borderRadius: '8px',
      fontSize: '11px',
      color: 'oklch(1 0 0 / 0.7)',
    },
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Observability</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{events.length} events</span>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Token throughput timeseries */}
          <TimeseriesCard
            label="Token Throughput"
            icon={<Zap className="size-3.5 text-sky-400/60" />}
            tooltipStyles={tooltipStyles}
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(65% 0.15 230)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="oklch(65% 0.15 230)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip {...tooltipStyles} />
              <Area
                type="monotone"
                dataKey="total_tokens"
                name="Tokens"
                stroke="oklch(65% 0.15 230)"
                strokeWidth={1.5}
                fill="url(#tokenGrad)"
              />
            </AreaChart>
          </TimeseriesCard>

          {/* Cost over time */}
          <TimeseriesCard
            label="Cost Over Time"
            icon={<DollarSign className="size-3.5 text-amber-400/60" />}
            tooltipStyles={tooltipStyles}
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(75% 0.15 80)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="oklch(75% 0.15 80)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={false}
                tickLine={false}
                width={50}
                tickFormatter={v => `$${Number(v).toFixed(4)}`}
              />
              <Tooltip
                {...tooltipStyles}
                formatter={value => [`$${Number(value).toFixed(6)}`, 'Cost']}
              />
              <Area
                type="monotone"
                dataKey="cost_dollars"
                name="Cost ($)"
                stroke="oklch(75% 0.15 80)"
                strokeWidth={1.5}
                fill="url(#costGrad)"
              />
            </AreaChart>
          </TimeseriesCard>

          {/* Agent utilization */}
          <TimeseriesCard
            label="Agent Utilization"
            icon={<Bot className="size-3.5 text-emerald-400/60" />}
            tooltipStyles={tooltipStyles}
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="workingGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(72% 0.19 160)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="oklch(72% 0.19 160)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="idleGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(1 0 0)" stopOpacity={0.1} />
                  <stop offset="100%" stopColor="oklch(1 0 0)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip {...tooltipStyles} />
              <Area
                type="monotone"
                dataKey="agents_total"
                name="Total"
                stroke="oklch(1 0 0 / 0.2)"
                strokeWidth={1}
                fill="url(#idleGrad)"
                stackId="agents"
              />
              <Area
                type="monotone"
                dataKey="agents_working"
                name="Working"
                stroke="oklch(72% 0.19 160)"
                strokeWidth={1.5}
                fill="url(#workingGrad)"
              />
            </AreaChart>
          </TimeseriesCard>

          {/* Bead velocity */}
          <TimeseriesCard
            label="Bead Velocity"
            icon={<Hexagon className="size-3.5 text-violet-400/60" />}
            tooltipStyles={tooltipStyles}
          >
            <BarChart data={chartData}>
              <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip {...tooltipStyles} />
              <Bar
                dataKey="beads_created"
                name="Created"
                fill="oklch(65% 0.15 280 / 0.6)"
                radius={[2, 2, 0, 0]}
              />
              <Bar
                dataKey="beads_closed"
                name="Closed"
                fill="oklch(72% 0.19 160 / 0.6)"
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </TimeseriesCard>

          {/* Lines of code changed */}
          <TimeseriesCard
            label="Lines of Code"
            icon={<FileCode className="size-3.5 text-violet-400/60" />}
            tooltipStyles={tooltipStyles}
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="locGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(65% 0.15 300)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="oklch(65% 0.15 300)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip {...tooltipStyles} />
              <Area
                type="monotone"
                dataKey="total_loc"
                name="Lines Changed"
                stroke="oklch(65% 0.15 300)"
                strokeWidth={1.5}
                fill="url(#locGrad)"
              />
            </AreaChart>
          </TimeseriesCard>

          {/* Event rate over time (legacy, from bead_events) */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Clock className="size-3.5 text-white/25" />
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Events / Hour — 24h
              </span>
            </div>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyData}>
                  <defs>
                    <linearGradient id="obsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(95% 0.15 108)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="oklch(95% 0.15 108)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="hour"
                    tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                    axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                    tickLine={false}
                    interval={3}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                  />
                  <Tooltip {...tooltipStyles} />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="oklch(95% 0.15 108)"
                    strokeWidth={1.5}
                    fill="url(#obsGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Event type distribution */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Hexagon className="size-3.5 text-white/25" />
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Event Types
              </span>
            </div>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={typeCounts} layout="vertical">
                  <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="type"
                    type="category"
                    tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.35)' }}
                    axisLine={false}
                    tickLine={false}
                    width={90}
                  />
                  <Tooltip {...tooltipStyles} />
                  <Bar dataKey="count" fill="oklch(95% 0.15 108 / 0.5)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Per-rig breakdown */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Bot className="size-3.5 text-white/25" />
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Events by Rig
              </span>
            </div>
            <div className="space-y-2">
              {rigEventCounts.map(({ rig, count }) => (
                <div key={rig} className="flex items-center justify-between">
                  <span className="truncate text-xs text-white/60">{rig}</span>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-1.5 rounded-full bg-[color:oklch(95%_0.15_108_/_0.4)]"
                      style={{
                        width: `${Math.max(
                          (count / Math.max(rigEventCounts[0]?.count ?? 1, 1)) * 100,
                          8
                        )}px`,
                      }}
                    />
                    <span className="font-mono text-[10px] text-white/30">{count}</span>
                  </div>
                </div>
              ))}
              {rigEventCounts.length === 0 && <p className="text-xs text-white/20">No rig data</p>}
            </div>
          </div>

          {/* Recent event stream */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-3.5 text-white/25" />
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Latest Events
              </span>
            </div>
            <div className="max-h-[180px] space-y-1 overflow-y-auto">
              {events
                .slice(-20)
                .reverse()
                .map(event => {
                  const EventIcon = EVENT_ICON_MAP[event.event_type] ?? Activity;
                  return (
                    <div
                      key={event.bead_event_id}
                      className="flex items-center gap-2 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-white/[0.03]"
                    >
                      <EventIcon className="size-3 shrink-0 text-white/25" />
                      <span className="flex-1 truncate text-white/55">{event.event_type}</span>
                      <span className="shrink-0 text-white/20">
                        {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared chart card wrapper ───────────────────────────────────────

function TimeseriesCard({
  label,
  icon,
  tooltipStyles,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  tooltipStyles: { contentStyle: React.CSSProperties };
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
          {label}
        </span>
      </div>
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const EVENT_ICON_MAP: Record<string, typeof Activity> = {
  created: Hexagon,
  hooked: Bot,
  unhooked: Bot,
  closed: Hexagon,
  escalated: AlertTriangle,
  review_submitted: GitMerge,
  review_completed: GitMerge,
  mail_sent: Mail,
};
