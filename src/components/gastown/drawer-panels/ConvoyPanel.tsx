'use client';

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ResourceRef } from '@/components/gastown/DrawerStack';

import { format } from 'date-fns';
import {
  Layers,
  GitBranch,
  Clock,
  Play,
  CheckCircle,
  Loader2,
  ArrowRight,
  Hexagon,
  Hash,
} from 'lucide-react';
import { toast } from 'sonner';

type ConvoyBead = {
  bead_id: string;
  title: string;
  status: string;
  rig_id: string | null;
  assignee_agent_name: string | null;
};

type DependencyEdge = {
  bead_id: string;
  depends_on_bead_id: string;
};

const STATUS_STYLES: Record<string, string> = {
  open: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  closed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

/**
 * Topological wave grouping via Kahn's algorithm.
 * Wave 0 = no incoming edges, Wave N = all blockers in prior waves.
 */
function computeWaves(beadList: ConvoyBead[], edges: DependencyEdge[]): ConvoyBead[][] {
  const beadIds = new Set(beadList.map(b => b.bead_id));
  const inDegree = new Map<string, number>();
  const blockedBy = new Map<string, string[]>();
  for (const b of beadList) {
    inDegree.set(b.bead_id, 0);
    blockedBy.set(b.bead_id, []);
  }
  for (const edge of edges) {
    if (!beadIds.has(edge.bead_id) || !beadIds.has(edge.depends_on_bead_id)) continue;
    inDegree.set(edge.bead_id, (inDegree.get(edge.bead_id) ?? 0) + 1);
    blockedBy.get(edge.bead_id)?.push(edge.depends_on_bead_id);
  }

  const beadById = new Map(beadList.map(b => [b.bead_id, b]));
  const waves: ConvoyBead[][] = [];
  const remaining = new Set(beadIds);

  while (remaining.size > 0) {
    const wave: ConvoyBead[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        const bead = beadById.get(id);
        if (bead) wave.push(bead);
      }
    }
    if (wave.length === 0) {
      const rest: ConvoyBead[] = [];
      for (const id of remaining) {
        const bead = beadById.get(id);
        if (bead) rest.push(bead);
      }
      waves.push(rest);
      break;
    }
    waves.push(wave);
    for (const bead of wave) remaining.delete(bead.bead_id);
    for (const id of remaining) {
      const blockers = blockedBy.get(id) ?? [];
      let newDeg = 0;
      for (const dep of blockers) {
        if (remaining.has(dep)) newDeg++;
      }
      inDegree.set(id, newDeg);
    }
  }
  return waves;
}

export function ConvoyPanel({
  convoyId,
  townId,
  push,
}: {
  convoyId: string;
  townId: string;
  push: (ref: ResourceRef) => void;
}) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const convoyQuery = useQuery({
    ...trpc.gastown.getConvoy.queryOptions({ townId, convoyId }),
    refetchInterval: 5_000,
  });

  const convoy = convoyQuery.data ?? null;

  const startConvoyMutation = useMutation(
    trpc.gastown.startConvoy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getConvoy.queryKey({ townId, convoyId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listConvoys.queryKey({ townId }),
        });
        toast.success('Convoy started');
      },
      onError: err => toast.error(err.message),
    })
  );

  const waves = useMemo(
    () => computeWaves(convoy?.beads ?? [], convoy?.dependency_edges ?? []),
    [convoy?.beads, convoy?.dependency_edges]
  );

  if (convoyQuery.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-white/20" />
      </div>
    );
  }

  if (!convoy) {
    return <div className="p-6 text-center text-sm text-white/30">Convoy not found</div>;
  }

  const progress = convoy.total_beads > 0 ? convoy.closed_beads / convoy.total_beads : 0;
  const hasDag = (convoy.dependency_edges ?? []).length > 0;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Layers className="size-4 text-violet-400" />
          <span className="text-xs font-medium tracking-wide text-white/40 uppercase">Convoy</span>
          {convoy.staged && (
            <Badge
              variant="outline"
              className="border-dashed border-amber-500/40 bg-amber-500/10 text-[9px] text-amber-300"
            >
              STAGED
            </Badge>
          )}
          {!convoy.staged && convoy.status === 'active' && (
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-[9px] text-emerald-300"
            >
              ACTIVE
            </Badge>
          )}
          {convoy.status === 'landed' && (
            <Badge
              variant="outline"
              className="border-violet-500/30 bg-violet-500/10 text-[9px] text-violet-300"
            >
              LANDED
            </Badge>
          )}
        </div>
        <h2 className="text-base font-semibold text-white/80">{convoy.title}</h2>
      </div>

      {/* Staged banner + start button */}
      {convoy.staged && (
        <div className="border-b border-amber-500/20 bg-amber-500/[0.04] px-5 py-3">
          <div className="mb-2 text-xs text-amber-300/70">
            This convoy is staged — agents have not been dispatched yet. Start the convoy when
            you&apos;re ready to begin execution.
          </div>
          <Button
            size="sm"
            onClick={() => startConvoyMutation.mutate({ townId, convoyId })}
            disabled={startConvoyMutation.isPending}
            className="bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
          >
            {startConvoyMutation.isPending ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : (
              <Play className="mr-1.5 size-3" />
            )}
            Start Convoy
          </Button>
        </div>
      )}

      {/* Progress */}
      <div className="border-b border-white/[0.06] px-5 py-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] text-white/40">Progress</span>
          <span className="font-mono text-[10px] text-white/30">
            {convoy.closed_beads}/{convoy.total_beads}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-emerald-500/60 transition-all duration-500"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-px border-b border-white/[0.06] bg-white/[0.02]">
        <MetaCell
          icon={<Hash className="size-3" />}
          label="ID"
          value={convoy.id.slice(0, 8)}
          mono
        />
        <MetaCell
          icon={<Clock className="size-3" />}
          label="Created"
          value={format(new Date(convoy.created_at), 'MMM d, HH:mm')}
        />
        {convoy.feature_branch && (
          <MetaCell
            icon={<GitBranch className="size-3" />}
            label="Branch"
            value={convoy.feature_branch}
            mono
            colSpan2
          />
        )}
        {convoy.merge_mode && (
          <MetaCell
            icon={<Layers className="size-3" />}
            label="Merge Mode"
            value={convoy.merge_mode}
            colSpan2
          />
        )}
      </div>

      {/* DAG: Bead list with wave structure */}
      <div className="px-5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Hexagon className="size-3 text-white/25" />
          <span className="text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Beads ({convoy.beads.length})
          </span>
        </div>

        {hasDag ? (
          <div className="space-y-2">
            {waves.map((wave, waveIdx) => (
              <div key={waveIdx}>
                {waveIdx > 0 && (
                  <div className="my-1.5 flex items-center gap-2 px-1">
                    <ArrowRight className="size-3 text-white/15" />
                    <span className="text-[9px] text-white/20">wave {waveIdx + 1}</span>
                    <div className="h-px flex-1 bg-white/[0.04]" />
                  </div>
                )}
                <div className="space-y-0.5">
                  {wave.map(bead => (
                    <BeadRow key={bead.bead_id} bead={bead} push={push} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {convoy.beads.map(bead => (
              <BeadRow key={bead.bead_id} bead={bead} push={push} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BeadRow({ bead, push }: { bead: ConvoyBead; push: (ref: ResourceRef) => void }) {
  return (
    <button
      onClick={() => {
        if (bead.rig_id) push({ type: 'bead', beadId: bead.bead_id, rigId: bead.rig_id });
      }}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      {bead.status === 'closed' ? (
        <CheckCircle className="size-3.5 shrink-0 text-emerald-400" />
      ) : bead.status === 'in_progress' ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-400" />
      ) : (
        <span
          className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT_COLORS[bead.status] ?? 'bg-white/20'}`}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-white/70">{bead.title}</span>
      <Badge
        variant="outline"
        className={`shrink-0 text-[9px] ${STATUS_STYLES[bead.status] ?? 'border-white/10 text-white/30'}`}
      >
        {bead.status}
      </Badge>
      {bead.assignee_agent_name && (
        <span className="shrink-0 text-[10px] text-white/25">{bead.assignee_agent_name}</span>
      )}
    </button>
  );
}

function MetaCell({
  icon,
  label,
  value,
  mono,
  colSpan2,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  colSpan2?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 ${colSpan2 ? 'col-span-2' : ''}`}>
      <span className="text-white/20">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] text-white/30">{label}</div>
        <div className={`truncate text-xs text-white/60 ${mono ? 'font-mono' : ''}`} title={value}>
          {value}
        </div>
      </div>
    </div>
  );
}
