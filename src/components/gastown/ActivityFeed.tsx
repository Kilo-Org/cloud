'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  GitMerge,
  AlertTriangle,
  CheckCircle,
  PlayCircle,
  PauseCircle,
  Mail,
  ChevronRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const EVENT_ICONS: Record<string, typeof Activity> = {
  created: PlayCircle,
  hooked: PlayCircle,
  unhooked: PauseCircle,
  status_changed: Activity,
  closed: CheckCircle,
  escalated: AlertTriangle,
  review_submitted: GitMerge,
  review_completed: GitMerge,
  mail_sent: Mail,
};

const EVENT_COLORS: Record<string, string> = {
  created: 'text-blue-500',
  hooked: 'text-green-500',
  unhooked: 'text-yellow-500',
  status_changed: 'text-purple-500',
  closed: 'text-green-600',
  escalated: 'text-red-500',
  review_submitted: 'text-indigo-500',
  review_completed: 'text-green-600',
  mail_sent: 'text-sky-500',
};

type RouterOutputs = inferRouterOutputs<RootRouter>;
type TownEvent = RouterOutputs['gastown']['getTownEvents'][number];
type BeadEvent = RouterOutputs['gastown']['getBeadEvents'][number];

function eventDescription(event: {
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown>;
  rig_name?: string;
}): string {
  const rigPrefix = event.rig_name ? `[${event.rig_name}] ` : '';
  switch (event.event_type) {
    case 'created': {
      const title = event.metadata?.title;
      return `${rigPrefix}Bead created: ${typeof title === 'string' ? title : (event.new_value ?? 'unknown')}`;
    }
    case 'hooked':
      return `${rigPrefix}Agent hooked to bead`;
    case 'unhooked':
      return `${rigPrefix}Agent unhooked from bead`;
    case 'status_changed':
      return `${rigPrefix}Status: ${event.old_value ?? '?'} → ${event.new_value ?? '?'}`;
    case 'closed':
      return `${rigPrefix}Bead closed`;
    case 'escalated':
      return `${rigPrefix}Escalation created`;
    case 'review_submitted':
      return `${rigPrefix}Submitted for review: ${event.new_value ?? ''}`;
    case 'review_completed':
      return `${rigPrefix}Review ${event.new_value ?? 'completed'}`;
    case 'mail_sent':
      return `${rigPrefix}Mail sent`;
    default:
      return `${rigPrefix}${event.event_type}`;
  }
}

function toEventDescriptionInput(event: TownEvent | BeadEvent) {
  return {
    event_type: event.event_type,
    old_value: event.old_value,
    new_value: event.new_value,
    metadata: event.metadata,
    rig_name: 'rig_name' in event ? event.rig_name : undefined,
  };
}

type ActivityFeedViewProps = {
  townId: string;
  events?: TownEvent[];
  isLoading?: boolean;
  onEventClick?: (event: TownEvent) => void;
};

export function ActivityFeedView({
  townId,
  events,
  isLoading,
  onEventClick,
}: ActivityFeedViewProps) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 50 }),
    refetchInterval: 5000,
    enabled: events === undefined,
  });

  const effectiveEvents = events ?? query.data;
  const effectiveLoading = isLoading ?? query.isLoading;

  const PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (effectiveLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.05 }}
            className="flex items-center gap-2"
          >
            <div className="size-4 rounded-full bg-white/[0.06]" />
            <div className="h-3 flex-1 rounded bg-white/[0.04]" />
          </motion.div>
        ))}
      </div>
    );
  }

  if (!effectiveEvents?.length) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-muted-foreground flex flex-col items-center justify-center p-6 text-sm"
      >
        <Activity className="mb-2 h-8 w-8 opacity-40" />
        <p>No activity yet</p>
      </motion.div>
    );
  }

  // Newest first — events from the API come oldest-first, so reverse.
  const sorted = [...effectiveEvents].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  const clickable = Boolean(onEventClick);

  return (
    <div className="space-y-0.5 p-2">
      <AnimatePresence initial={false}>
        {visible.map(event => {
          const Icon = EVENT_ICONS[event.event_type] ?? Activity;
          const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

          return (
            <motion.div
              key={event.bead_event_id}
              layout
              initial={{ opacity: 0, height: 0, y: -8 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onEventClick?.(event) : undefined}
              onKeyDown={
                clickable
                  ? e => {
                      if (e.key === 'Enter' || e.key === ' ') onEventClick?.(event);
                    }
                  : undefined
              }
              className={`flex items-start gap-2 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-white/[0.05] ${clickable ? 'cursor-pointer' : ''}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-white/85">
                  {eventDescription(toEventDescriptionInput(event))}
                </p>
                <p className="text-xs text-white/40">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </p>
              </div>
              {clickable && <ChevronRight className="mt-1 size-3 shrink-0 text-white/15" />}
            </motion.div>
          );
        })}
      </AnimatePresence>
      {hasMore && (
        <button
          onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/55"
        >
          Show more
          <span className="font-mono text-[10px] text-white/20">
            {sorted.length - visibleCount} remaining
          </span>
        </button>
      )}
    </div>
  );
}

export type { TownEvent };

export function ActivityFeed({ townId }: { townId: string }) {
  return <ActivityFeedView townId={townId} />;
}

export function BeadEventTimeline({ rigId, beadId }: { rigId: string; beadId: string }) {
  const trpc = useTRPC();
  const { data: events, isLoading } = useQuery({
    ...trpc.gastown.getBeadEvents.queryOptions({ rigId, beadId }),
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.06 }}
            className="flex items-center gap-2"
          >
            <div className="size-3 rounded-full bg-white/[0.06]" />
            <div className="h-2.5 flex-1 rounded bg-white/[0.04]" />
          </motion.div>
        ))}
      </div>
    );
  }

  if (!events?.length) {
    return <p className="text-muted-foreground p-2 text-xs">No events</p>;
  }

  return (
    <div className="space-y-1 p-2">
      <AnimatePresence initial={false}>
        {events.map((event, i) => {
          const Icon = EVENT_ICONS[event.event_type] ?? Activity;
          const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

          return (
            <motion.div
              key={event.bead_event_id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03, duration: 0.2 }}
              className="flex items-start gap-2 py-1 text-xs"
            >
              <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${color}`} />
              <div className="min-w-0 flex-1">
                <span className="text-foreground">
                  {eventDescription(toEventDescriptionInput(event))}
                </span>
                <span className="text-muted-foreground ml-1">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
