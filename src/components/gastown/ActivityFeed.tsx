'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  GitMerge,
  AlertTriangle,
  CheckCircle,
  PlayCircle,
  PauseCircle,
  Mail,
} from 'lucide-react';

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

export function ActivityFeed({ townId }: { townId: string }) {
  const trpc = useTRPC();
  const { data: events, isLoading } = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 50 }),
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex animate-pulse items-center gap-2">
            <div className="bg-muted h-4 w-4 rounded-full" />
            <div className="bg-muted h-3 flex-1 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!events?.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-6 text-sm">
        <Activity className="mb-2 h-8 w-8 opacity-40" />
        <p>No activity yet</p>
      </div>
    );
  }

  // Show newest first
  const sorted = [...events].reverse();

  return (
    <div className="max-h-[420px] space-y-1 overflow-y-auto p-2">
      {sorted.map(event => {
        const Icon = EVENT_ICONS[event.event_type] ?? Activity;
        const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

        return (
          <div
            key={event.id}
            className="flex items-start gap-2 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-white/[0.05]"
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-white/85">
                {eventDescription(event as Parameters<typeof eventDescription>[0])}
              </p>
              <p className="text-xs text-white/40">
                {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
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
          <div key={i} className="flex animate-pulse items-center gap-2">
            <div className="bg-muted h-3 w-3 rounded-full" />
            <div className="bg-muted h-2.5 flex-1 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!events?.length) {
    return <p className="text-muted-foreground p-2 text-xs">No events</p>;
  }

  return (
    <div className="space-y-1 p-2">
      {events.map(event => {
        const Icon = EVENT_ICONS[event.event_type] ?? Activity;
        const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

        return (
          <div key={event.id} className="flex items-start gap-2 py-1 text-xs">
            <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${color}`} />
            <div className="min-w-0 flex-1">
              <span className="text-foreground">
                {eventDescription(event as Parameters<typeof eventDescription>[0])}
              </span>
              <span className="text-muted-foreground ml-1">
                {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
