'use client';

import { Drawer } from 'vaul';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/Button';
import { BeadEventTimeline } from '@/components/gastown/ActivityFeed';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { format } from 'date-fns';
import { Clock, Flag, Hash, Tags, User, X, Hexagon, FileText, GitBranch } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Bead = RouterOutputs['gastown']['listBeads'][number];

type BeadDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bead: Bead | null;
  rigId: string;
  agentNameById?: Record<string, string>;
  onDelete?: () => void;
};

const STATUS_STYLES: Record<string, string> = {
  open: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  closed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const PRIORITY_STYLES: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-white/50',
};

export function BeadDetailDrawer({
  open,
  onOpenChange,
  bead,
  rigId,
  agentNameById,
  onDelete,
}: BeadDetailDrawerProps) {
  const assigneeName = bead?.assignee_agent_bead_id
    ? agentNameById?.[bead.assignee_agent_bead_id]
    : null;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Drawer.Content
          className="fixed top-0 right-0 bottom-0 z-50 flex w-[520px] max-w-[94vw] flex-col outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.08] bg-[oklch(0.12_0_0)]">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-white/[0.06] px-5 pt-5 pb-4">
              <div className="min-w-0 flex-1">
                <Drawer.Title className="flex items-center gap-2 text-base font-semibold text-white/90">
                  <Hexagon className="size-4 shrink-0 text-[color:oklch(95%_0.15_108_/_0.7)]" />
                  <span className="truncate">{bead?.title ?? 'Bead'}</span>
                </Drawer.Title>
                <Drawer.Description className="mt-1.5 text-xs text-white/35">
                  Full inspection view — metadata, body, and event timeline.
                </Drawer.Description>

                {bead && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[bead.status] ?? 'border-white/10 text-white/50'}`}
                    >
                      {bead.status.replace('_', ' ')}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {bead.type}
                    </Badge>
                    <span
                      className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${PRIORITY_STYLES[bead.priority] ?? 'text-white/50'}`}
                    >
                      <Flag className="size-2.5" />
                      {bead.priority}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {onDelete && bead && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onDelete}
                    className="border border-red-500/20 bg-red-500/10 text-xs text-red-300 hover:bg-red-500/15"
                  >
                    Delete
                  </Button>
                )}
                <button
                  onClick={() => onOpenChange(false)}
                  className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {!bead ? (
                <div className="p-6 text-center text-sm text-white/30">
                  Select a bead to inspect.
                </div>
              ) : (
                <div className="flex flex-col gap-0">
                  {/* Metadata grid */}
                  <div className="grid grid-cols-2 border-b border-white/[0.06]">
                    <MetaCell icon={Hash} label="Bead ID" value={bead.bead_id.slice(0, 8)} mono />
                    <MetaCell
                      icon={Clock}
                      label="Created"
                      value={format(new Date(bead.created_at), 'MMM d, HH:mm')}
                    />
                    <MetaCell
                      icon={User}
                      label="Assignee"
                      value={
                        assigneeName ??
                        (bead.assignee_agent_bead_id
                          ? bead.assignee_agent_bead_id.slice(0, 8)
                          : 'Unassigned')
                      }
                    />
                    <MetaCell
                      icon={Tags}
                      label="Labels"
                      value={bead.labels.length ? bead.labels.join(', ') : 'None'}
                    />
                    {bead.parent_bead_id && (
                      <MetaCell
                        icon={GitBranch}
                        label="Parent"
                        value={bead.parent_bead_id.slice(0, 8)}
                        mono
                      />
                    )}
                  </div>

                  {/* Body */}
                  {bead.body && bead.body.trim().length > 0 && (
                    <div className="border-b border-white/[0.06] px-5 py-4">
                      <div className="mb-2 flex items-center gap-1.5">
                        <FileText className="size-3 text-white/25" />
                        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
                          Description
                        </span>
                      </div>
                      <div className="prose prose-sm prose-invert prose-headings:text-white/80 prose-p:text-white/65 prose-a:text-[color:oklch(95%_0.15_108)] prose-strong:text-white/80 prose-code:rounded prose-code:bg-white/[0.06] prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] prose-code:text-white/70 prose-pre:bg-white/[0.04] prose-pre:border prose-pre:border-white/[0.06] prose-li:text-white/65 max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{bead.body}</ReactMarkdown>
                      </div>
                    </div>
                  )}

                  {/* Event Timeline */}
                  <div className="px-5 pt-4 pb-2">
                    <div className="mb-2 flex items-center gap-1.5">
                      <Clock className="size-3 text-white/25" />
                      <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
                        Event Timeline
                      </span>
                    </div>
                  </div>
                  <div className="px-3 pb-6">
                    <BeadEventTimeline rigId={rigId} beadId={bead.bead_id} />
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
    <div className="border-r border-b border-white/[0.04] px-4 py-3 last:border-r-0 [&:nth-child(2n)]:border-r-0">
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
