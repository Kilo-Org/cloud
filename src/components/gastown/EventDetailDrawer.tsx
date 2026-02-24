'use client';

import { Drawer } from 'vaul';
import type { TownEvent } from './ActivityFeed';
import { format, formatDistanceToNow } from 'date-fns';
import {
  X,
  Activity,
  GitMerge,
  AlertTriangle,
  CheckCircle,
  PlayCircle,
  PauseCircle,
  Mail,
  Hash,
  Clock,
  Bot,
  Hexagon,
  FileText,
  ArrowRight,
} from 'lucide-react';

type EventDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: TownEvent | null;
};

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

const EVENT_ACCENT: Record<string, string> = {
  created: 'border-sky-500/20 bg-sky-500/8',
  hooked: 'border-emerald-500/20 bg-emerald-500/8',
  unhooked: 'border-amber-500/20 bg-amber-500/8',
  status_changed: 'border-violet-500/20 bg-violet-500/8',
  closed: 'border-emerald-500/20 bg-emerald-500/8',
  escalated: 'border-red-500/20 bg-red-500/8',
  review_submitted: 'border-indigo-500/20 bg-indigo-500/8',
  review_completed: 'border-emerald-500/20 bg-emerald-500/8',
  mail_sent: 'border-sky-500/20 bg-sky-500/8',
};

const EVENT_ICON_COLOR: Record<string, string> = {
  created: 'text-sky-400',
  hooked: 'text-emerald-400',
  unhooked: 'text-amber-400',
  status_changed: 'text-violet-400',
  closed: 'text-emerald-400',
  escalated: 'text-red-400',
  review_submitted: 'text-indigo-400',
  review_completed: 'text-emerald-400',
  mail_sent: 'text-sky-400',
};

const EVENT_LABEL: Record<string, string> = {
  created: 'Bead Created',
  hooked: 'Agent Hooked',
  unhooked: 'Agent Unhooked',
  status_changed: 'Status Changed',
  closed: 'Bead Closed',
  escalated: 'Escalation Created',
  review_submitted: 'Submitted for Review',
  review_completed: 'Review Completed',
  mail_sent: 'Mail Sent',
};

export function EventDetailDrawer({ open, onOpenChange, event }: EventDetailDrawerProps) {
  if (!event) return null;

  const Icon = EVENT_ICONS[event.event_type] ?? Activity;
  const accent = EVENT_ACCENT[event.event_type] ?? 'border-white/10 bg-white/5';
  const iconColor = EVENT_ICON_COLOR[event.event_type] ?? 'text-white/50';
  const label = EVENT_LABEL[event.event_type] ?? event.event_type;

  const metadataEntries = Object.entries(event.metadata).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content
          className="fixed top-0 right-0 bottom-0 z-50 flex w-[440px] max-w-[92vw] flex-col outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.08] bg-[oklch(0.12_0_0)]">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-white/[0.06] px-5 pt-5 pb-4">
              <div className="min-w-0 flex-1">
                <Drawer.Title className="text-base font-semibold text-white/90">
                  Event Detail
                </Drawer.Title>
                <Drawer.Description className="mt-1 text-xs text-white/30">
                  Full context for this activity event.
                </Drawer.Description>
              </div>
              <button
                onClick={() => onOpenChange(false)}
                className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Event type banner */}
              <div className={`mx-5 mt-4 rounded-xl border p-4 ${accent}`}>
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-10 items-center justify-center rounded-lg bg-black/20 ${iconColor}`}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white/85">{label}</div>
                    <div className="mt-0.5 text-[10px] text-white/40 capitalize">
                      {event.event_type.replace(/_/g, ' ')}
                    </div>
                  </div>
                </div>
              </div>

              {/* Metadata grid */}
              <div className="mt-4 border-t border-white/[0.06]">
                <div className="grid grid-cols-2">
                  <MetaCell
                    icon={Hash}
                    label="Event ID"
                    value={event.bead_event_id.slice(0, 12)}
                    mono
                  />
                  <MetaCell
                    icon={Clock}
                    label="Time"
                    value={format(new Date(event.created_at), 'MMM d, HH:mm:ss')}
                  />
                  <MetaCell icon={Hexagon} label="Bead" value={event.bead_id.slice(0, 12)} mono />
                  <MetaCell
                    icon={Bot}
                    label="Agent"
                    value={event.agent_id ? event.agent_id.slice(0, 12) : 'System'}
                    mono={Boolean(event.agent_id)}
                  />
                  {'rig_name' in event && event.rig_name && (
                    <MetaCell icon={FileText} label="Rig" value={event.rig_name} />
                  )}
                  <MetaCell
                    icon={Clock}
                    label="Relative"
                    value={formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                  />
                </div>
              </div>

              {/* Value transition */}
              {(event.old_value || event.new_value) && (
                <div className="mx-5 mt-4">
                  <div className="mb-2 text-[10px] font-medium tracking-wide text-white/30 uppercase">
                    Value Change
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                    <span className="max-w-[140px] truncate rounded bg-white/[0.04] px-2 py-1 font-mono text-xs text-white/50">
                      {event.old_value ?? '—'}
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-white/20" />
                    <span className="max-w-[140px] truncate rounded bg-white/[0.04] px-2 py-1 font-mono text-xs text-white/70">
                      {event.new_value ?? '—'}
                    </span>
                  </div>
                </div>
              )}

              {/* Metadata */}
              {metadataEntries.length > 0 && (
                <div className="mx-5 mt-4 pb-6">
                  <div className="mb-2 text-[10px] font-medium tracking-wide text-white/30 uppercase">
                    Metadata
                  </div>
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
                    {metadataEntries.map(([key, value], i) => (
                      <div
                        key={key}
                        className={`flex items-start justify-between gap-4 px-3 py-2 ${
                          i < metadataEntries.length - 1 ? 'border-b border-white/[0.04]' : ''
                        }`}
                      >
                        <span className="shrink-0 text-[11px] text-white/40">{key}</span>
                        <span className="min-w-0 truncate text-right font-mono text-[11px] text-white/65">
                          {typeof value === 'string' ? value : JSON.stringify(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function MetaCell({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border-r border-b border-white/[0.04] px-4 py-3 [&:nth-child(2n)]:border-r-0">
      <div className="flex items-center gap-1 text-[10px] text-white/30">
        <Icon className="size-3" />
        {label}
      </div>
      <div className={`mt-0.5 truncate text-sm text-white/75 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </div>
    </div>
  );
}
