'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Activity, Clock, Hexagon, Bot, GitMerge, AlertTriangle, Mail } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
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

export function ObservabilityPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();

  const eventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 500 }),
    refetchInterval: 5_000,
  });

  const events = eventsQuery.data ?? [];

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
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-3" />
          <Activity className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Observability</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{events.length} events</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Event rate over time */}
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
