'use client';

import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { BeadEventTimeline } from '@/components/gastown/ActivityFeed';
import { useTerminalBar } from '@/components/gastown/TerminalBarContext';
import type { ResourceRef } from '@/components/gastown/DrawerStack';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Bot,
  Crown,
  Shield,
  Eye,
  Hash,
  Clock,
  Hexagon,
  Terminal,
  Zap,
  Activity,
  ChevronRight,
} from 'lucide-react';

const ROLE_ICONS: Record<string, typeof Bot> = {
  polecat: Bot,
  mayor: Crown,
  refinery: Shield,
  witness: Eye,
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-white/25',
  working: 'bg-emerald-400',
  stalled: 'bg-amber-400',
  dead: 'bg-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  stalled: 'Stalled',
  dead: 'Dead',
};

const BEAD_STATUS_DOT: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

export function AgentPanel({
  agentId,
  rigId,
  townId: _townIdProp,
  push,
  close,
}: {
  agentId: string;
  rigId: string;
  townId?: string;
  push: (ref: ResourceRef) => void;
  close: () => void;
}) {
  const trpc = useGastownTRPC();
  const { openAgentTab } = useTerminalBar();

  const agentsQuery = useQuery(trpc.gastown.listAgents.queryOptions({ rigId }));
  const beadsQuery = useQuery({
    ...trpc.gastown.listBeads.queryOptions({ rigId }),
    refetchInterval: 8_000,
  });

  const agent = (agentsQuery.data ?? []).find(a => a.id === agentId);
  const relatedBeads = (beadsQuery.data ?? []).filter(b => b.assignee_agent_bead_id === agentId);

  if (!agent) {
    return <div className="p-6 text-center text-sm text-white/30">Loading agent…</div>;
  }

  const RoleIcon = ROLE_ICONS[agent.role] ?? Bot;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-5 pt-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-white/[0.05] ring-1 ring-white/[0.08]">
            <RoleIcon className="size-5 text-white/50" />
          </div>
          <div>
            <div className="text-base font-semibold text-white/90">{agent.name}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-white/35">
              <span className="capitalize">{agent.role}</span>
              <span className="text-white/15">·</span>
              <span className="flex items-center gap-1">
                <span
                  className={`size-1.5 rounded-full ${STATUS_DOT[agent.status] ?? 'bg-white/20'}`}
                />
                {STATUS_LABEL[agent.status] ?? agent.status}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => {
              openAgentTab(agent.id, agent.name);
              close();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[color:oklch(95%_0.15_108_/_0.12)] px-3 py-1.5 text-xs font-medium text-[color:oklch(95%_0.15_108)] ring-1 ring-[color:oklch(95%_0.15_108_/_0.2)] transition-colors hover:bg-[color:oklch(95%_0.15_108_/_0.2)]"
          >
            <Terminal className="size-3.5" />
            Connect
          </button>
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 border-b border-white/[0.06]">
        <MetaCell icon={Hash} label="ID" value={agent.id.slice(0, 12)} mono />
        <MetaCell
          icon={Clock}
          label="Created"
          value={format(new Date(agent.created_at), 'MMM d, HH:mm')}
        />
        <MetaCell icon={Zap} label="Dispatch Attempts" value={String(agent.dispatch_attempts)} />
        <MetaCell
          icon={Activity}
          label="Last Active"
          value={
            agent.last_activity_at
              ? formatDistanceToNow(new Date(agent.last_activity_at), { addSuffix: true })
              : 'Never'
          }
        />

        {/* Hooked bead — clickable */}
        {agent.current_hook_bead_id ? (
          <button
            onClick={() => push({ type: 'bead', beadId: agent.current_hook_bead_id ?? '', rigId })}
            className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
          >
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <Hexagon className="size-3" />
              Hooked Bead
            </div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[color:oklch(95%_0.15_108)]">
              <span>{agent.current_hook_bead_id.slice(0, 12)}</span>
              <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
            </div>
          </button>
        ) : (
          <MetaCell icon={Hexagon} label="Hooked Bead" value="None" />
        )}

        <MetaCell icon={Bot} label="Identity" value={agent.identity || 'Default'} />
      </div>

      {/* Related Beads — clickable rows */}
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Hexagon className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
              Assigned Beads
            </span>
          </div>
          <span className="font-mono text-[10px] text-white/20">{relatedBeads.length}</span>
        </div>

        {relatedBeads.length === 0 ? (
          <p className="text-xs text-white/20">No beads assigned to this agent.</p>
        ) : (
          <div className="space-y-1.5">
            {relatedBeads.map(bead => (
              <button
                key={bead.bead_id}
                onClick={() => push({ type: 'bead', beadId: bead.bead_id, rigId })}
                className="group/bead flex w-full items-center gap-2.5 rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2 text-left transition-colors hover:border-white/[0.1] hover:bg-white/[0.03]"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${BEAD_STATUS_DOT[bead.status] ?? 'bg-white/20'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-white/70">{bead.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/30">
                    <span className="font-mono">{bead.bead_id.slice(0, 8)}</span>
                    <span className="text-white/10">·</span>
                    <span className="capitalize">{bead.status.replace('_', ' ')}</span>
                  </div>
                </div>
                <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/bead:text-white/25" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hooked Bead Event Timeline */}
      {agent.current_hook_bead_id && (
        <>
          <div className="px-5 pt-4">
            <div className="mb-2 flex items-center gap-1.5">
              <Clock className="size-3 text-white/25" />
              <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
                Hooked Bead Events
              </span>
            </div>
          </div>
          <div className="px-3 pb-6">
            <BeadEventTimeline rigId={rigId} beadId={agent.current_hook_bead_id} />
          </div>
        </>
      )}
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
