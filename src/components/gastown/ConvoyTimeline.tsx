'use client';

import { useState, useMemo } from 'react';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import { CheckCircle, GitBranch, Loader2, X, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type ConvoyDetail = GastownOutputs['gastown']['listConvoys'][number];
type ConvoyBead = ConvoyDetail['beads'][number];
type DependencyEdge = ConvoyDetail['dependency_edges'][number];

export type ConvoyTimelineProps = {
  convoys: ConvoyDetail[];
  collapsed?: boolean;
  onSelectBead?: (beadId: string, rigId: string | null) => void;
  onCloseConvoy?: (convoyId: string) => void;
};

const STATUS_COLORS: Record<string, string> = {
  open: 'border-sky-500/40 bg-sky-500/15',
  in_progress: 'border-amber-500/40 bg-amber-500/15',
  closed: 'border-emerald-500/40 bg-emerald-500/15',
  failed: 'border-red-500/40 bg-red-500/15',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

/**
 * Compute topological waves from beads and dependency edges using Kahn's algorithm.
 * Wave 0 = beads with no incoming 'blocks' edges (can run immediately).
 * Wave N = beads whose all blockers are in waves < N.
 * Returns beads grouped by wave index, preserving creation order within each wave.
 */
function computeWaves(beadList: ConvoyBead[], edges: DependencyEdge[]): ConvoyBead[][] {
  const beadIds = new Set(beadList.map(b => b.bead_id));

  // Build in-degree map and adjacency list (only for beads in this convoy)
  const inDegree = new Map<string, number>();
  const blockedBy = new Map<string, string[]>(); // bead_id → list of blockers
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
    // Collect all beads with in-degree 0
    const wave: ConvoyBead[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        const bead = beadById.get(id);
        if (bead) wave.push(bead);
      }
    }

    // If no zero-degree nodes remain, there's a cycle — dump remaining as final wave
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

    // Remove wave nodes and decrement in-degrees
    for (const bead of wave) {
      remaining.delete(bead.bead_id);
    }
    for (const id of remaining) {
      const blockers = blockedBy.get(id) ?? [];
      let newDegree = 0;
      for (const dep of blockers) {
        if (remaining.has(dep)) newDegree++;
      }
      inDegree.set(id, newDegree);
    }
  }

  return waves;
}

/**
 * Renders convoy progress as horizontal timeline tracks with DAG visualization.
 * Beads are grouped into waves based on dependency edges.
 * Collapse state is managed by the parent via the `collapsed` prop.
 */
export function ConvoyTimeline({
  convoys,
  collapsed = false,
  onSelectBead,
  onCloseConvoy,
}: ConvoyTimelineProps) {
  if (convoys.length === 0) {
    return null;
  }

  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="min-w-0 space-y-3 overflow-hidden"
        >
          {convoys.map(convoy => (
            <ConvoyCard
              key={convoy.id}
              convoy={convoy}
              onSelectBead={onSelectBead}
              onClose={onCloseConvoy ? () => onCloseConvoy(convoy.id) : undefined}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ConvoyCard({
  convoy,
  onSelectBead,
  onClose,
}: {
  convoy: ConvoyDetail;
  onSelectBead?: (beadId: string, rigId: string | null) => void;
  onClose?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const progress = convoy.total_beads > 0 ? convoy.closed_beads / convoy.total_beads : 0;

  const waves = useMemo(
    () => computeWaves(convoy.beads, convoy.dependency_edges ?? []),
    [convoy.beads, convoy.dependency_edges]
  );

  const hasDag = (convoy.dependency_edges ?? []).length > 0;

  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      {/* Convoy header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">
            CONVOY
          </span>
          <span className="max-w-[300px] truncate text-xs font-medium text-white/70">
            {convoy.title}
          </span>
          {convoy.feature_branch && (
            <span
              className="flex items-center gap-1 text-[9px] text-white/25"
              title={convoy.feature_branch}
            >
              <GitBranch className="size-2.5" />
              <span className="max-w-[140px] truncate font-mono">{convoy.feature_branch}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/30">
            {convoy.closed_beads}/{convoy.total_beads}
          </span>
          {onClose && (
            <>
              {confirming ? (
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      onClose();
                      setConfirming(false);
                    }}
                    className="rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-medium text-red-400 transition-colors hover:bg-red-500/30"
                  >
                    Close all
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="text-[9px] text-white/30 transition-colors hover:text-white/50"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  className="rounded p-0.5 text-white/20 transition-colors hover:bg-white/[0.06] hover:text-white/40"
                  title="Close convoy and all beads"
                >
                  <X className="size-3" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="h-full rounded-full bg-emerald-500/60"
          initial={{ width: 0 }}
          animate={{ width: `${progress * 100}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>

      {/* DAG wave layout or flat list */}
      {hasDag ? (
        <div className="relative isolate flex items-center gap-0.5 overflow-x-auto py-0.5">
          {waves.map((wave, waveIdx) => (
            <div key={waveIdx} className="flex items-center gap-0.5">
              {waveIdx > 0 && <ArrowRight className="mx-1 size-3 shrink-0 text-white/15" />}
              <div className="flex flex-col gap-1">
                {wave.length > 1 && (
                  <span className="text-center text-[8px] text-white/20">wave {waveIdx + 1}</span>
                )}
                <div className="flex gap-1">
                  {wave.map((bead, i) => (
                    <BeadChip
                      key={bead.bead_id}
                      bead={bead}
                      delay={waveIdx * 0.1 + i * 0.05}
                      onSelect={onSelectBead}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="relative isolate flex items-center gap-1 overflow-x-auto py-0.5">
          <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-white/[0.06]" />
          {convoy.beads.map((bead, i) => (
            <BeadChip key={bead.bead_id} bead={bead} delay={i * 0.05} onSelect={onSelectBead} />
          ))}
        </div>
      )}
    </div>
  );
}

function BeadChip({
  bead,
  delay,
  onSelect,
}: {
  bead: ConvoyBead;
  delay: number;
  onSelect?: (beadId: string, rigId: string | null) => void;
}) {
  return (
    <motion.button
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay, duration: 0.2 }}
      onClick={() => onSelect?.(bead.bead_id, bead.rig_id)}
      className={`relative z-10 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-all hover:scale-105 ${STATUS_COLORS[bead.status] ?? 'border-white/10 bg-white/[0.03]'}`}
      title={`${bead.title} (${bead.status})${bead.assignee_agent_name ? ` — ${bead.assignee_agent_name}` : ''}`}
    >
      {bead.status === 'closed' ? (
        <CheckCircle className="size-3 text-emerald-400" />
      ) : bead.status === 'in_progress' ? (
        <Loader2 className="size-3 animate-spin text-amber-400" />
      ) : (
        <span
          className={`size-2 rounded-full ${STATUS_DOT_COLORS[bead.status] ?? 'bg-white/20'}`}
        />
      )}
      <span className="max-w-[100px] truncate text-white/70">{bead.title}</span>
      {bead.assignee_agent_name && (
        <span className="ml-0.5 text-white/25">{bead.assignee_agent_name}</span>
      )}
    </motion.button>
  );
}
