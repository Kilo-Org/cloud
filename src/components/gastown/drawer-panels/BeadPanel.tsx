'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { BeadEventTimeline } from '@/components/gastown/ActivityFeed';
import type { ResourceRef } from '@/components/gastown/DrawerStack';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { format } from 'date-fns';
import {
  Clock,
  Flag,
  Hash,
  Tags,
  User,
  Hexagon,
  FileText,
  GitBranch,
  ChevronRight,
  Bot,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Bead = RouterOutputs['gastown']['listBeads'][number];

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

export function BeadPanel({
  beadId,
  rigId,
  push,
}: {
  beadId: string;
  rigId: string;
  push: (ref: ResourceRef) => void;
}) {
  const trpc = useTRPC();
  const beadsQuery = useQuery(trpc.gastown.listBeads.queryOptions({ rigId }));
  const agentsQuery = useQuery(trpc.gastown.listAgents.queryOptions({ rigId }));
  const rigQuery = useQuery(trpc.gastown.getRig.queryOptions({ rigId }));

  const bead = (beadsQuery.data ?? []).find(b => b.bead_id === beadId);
  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  if (!bead) {
    return <div className="p-6 text-center text-sm text-white/30">Loading bead…</div>;
  }

  const assigneeName = bead.assignee_agent_bead_id
    ? agentNameById[bead.assignee_agent_bead_id]
    : null;

  const townId = rigQuery.data?.town_id;

  return (
    <div className="flex flex-col gap-0">
      {/* Title area */}
      <div className="border-b border-white/[0.06] px-5 pt-4 pb-4">
        <div className="flex items-center gap-2 text-base font-semibold text-white/90">
          <Hexagon className="size-4 shrink-0 text-[color:oklch(95%_0.15_108_/_0.7)]" />
          <span className="truncate">{bead.title}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 border-b border-white/[0.06]">
        <MetaCell icon={Hash} label="Bead ID" value={bead.bead_id.slice(0, 8)} mono />
        <MetaCell
          icon={Clock}
          label="Created"
          value={format(new Date(bead.created_at), 'MMM d, HH:mm')}
        />

        {/* Assignee — clickable to open agent drawer */}
        {bead.assignee_agent_bead_id ? (
          <button
            onClick={() => {
              if (townId) {
                push({
                  type: 'agent',
                  agentId: bead.assignee_agent_bead_id ?? '',
                  rigId,
                  townId,
                });
              }
            }}
            className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
          >
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <User className="size-3" />
              Assignee
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-sm text-[color:oklch(95%_0.15_108)]">
              <Bot className="size-3" />
              <span className="truncate">
                {assigneeName ?? bead.assignee_agent_bead_id.slice(0, 8)}
              </span>
              <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
            </div>
          </button>
        ) : (
          <MetaCell icon={User} label="Assignee" value="Unassigned" />
        )}

        <MetaCell
          icon={Tags}
          label="Labels"
          value={bead.labels.length ? bead.labels.join(', ') : 'None'}
        />

        {/* Parent bead — clickable */}
        {bead.parent_bead_id && (
          <button
            onClick={() => push({ type: 'bead', beadId: bead.parent_bead_id ?? '', rigId })}
            className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
          >
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <GitBranch className="size-3" />
              Parent Bead
            </div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[color:oklch(95%_0.15_108)]">
              <span>{bead.parent_bead_id.slice(0, 8)}</span>
              <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
            </div>
          </button>
        )}
      </div>

      {/* Body (markdown) */}
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
