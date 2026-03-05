'use client';

import { useMemo } from 'react';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import { Hexagon, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

type Bead = GastownOutputs['gastown']['listBeads'][number];

type ConvoyTimelineProps = {
  /** All beads from a rig (or across rigs) */
  beads: Bead[];
  agentNameById: Record<string, string>;
  onSelectBead?: (beadId: string) => void;
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
 * Horizontal timeline showing bead completion events over time.
 * Groups beads by parent_bead_id to form "convoys".
 */
export function ConvoyTimeline({ beads, agentNameById, onSelectBead }: ConvoyTimelineProps) {
  // Group into convoys by parent_bead_id
  const convoys = useMemo(() => {
    const groups: Record<string, Bead[]> = {};
    const standalone: Bead[] = [];

    for (const bead of beads) {
      if (bead.parent_bead_id) {
        const key = bead.parent_bead_id;
        groups[key] ??= [];
        groups[key].push(bead);
      } else {
        standalone.push(bead);
      }
    }

    const result: Array<{ id: string; label: string; beads: Bead[]; isConvoy: boolean }> = [];

    // Add actual convoys
    for (const [parentId, children] of Object.entries(groups)) {
      const parent = beads.find(b => b.bead_id === parentId);
      result.push({
        id: parentId,
        label: parent?.title ?? `Convoy ${parentId.slice(0, 8)}`,
        beads: children.sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ),
        isConvoy: true,
      });
    }

    // Add standalone beads as single-bead "convoys"
    for (const bead of standalone) {
      if (!groups[bead.bead_id]) {
        result.push({
          id: bead.bead_id,
          label: bead.title,
          beads: [bead],
          isConvoy: false,
        });
      }
    }

    return result;
  }, [beads]);

  if (beads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Hexagon className="mb-2 size-6 text-white/10" />
        <p className="text-xs text-white/25">No beads to visualize.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {convoys.map(convoy => {
        const completedCount = convoy.beads.filter(b => b.status === 'closed').length;
        const total = convoy.beads.length;
        const hasStalled = convoy.beads.some(b => b.status === 'open' && !b.assignee_agent_bead_id);

        return (
          <div
            key={convoy.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
          >
            {/* Convoy header */}
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {convoy.isConvoy && (
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-white/40">
                    CONVOY
                  </span>
                )}
                <span className="max-w-[300px] truncate text-xs font-medium text-white/70">
                  {convoy.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {hasStalled && (
                  <span className="flex items-center gap-1 text-[9px] text-orange-400">
                    <AlertTriangle className="size-2.5" />
                    Stranded
                  </span>
                )}
                <span className="font-mono text-[10px] text-white/30">
                  {completedCount}/{total}
                </span>
              </div>
            </div>

            {/* Timeline track */}
            <div className="relative flex items-center gap-1 overflow-x-auto py-1">
              {/* Track line */}
              <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-white/[0.06]" />

              {convoy.beads.map((bead, i) => {
                const assigneeName = bead.assignee_agent_bead_id
                  ? agentNameById[bead.assignee_agent_bead_id]
                  : null;

                return (
                  <motion.button
                    key={bead.bead_id}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: i * 0.06, duration: 0.25 }}
                    onClick={() => onSelectBead?.(bead.bead_id)}
                    className={`relative z-10 flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] transition-all hover:scale-105 ${STATUS_COLORS[bead.status] ?? 'border-white/10 bg-white/[0.03]'}`}
                    title={`${bead.title} (${bead.status})`}
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
                    <span className="max-w-[80px] truncate text-white/70">
                      {bead.title.slice(0, 20)}
                    </span>
                    {assigneeName && <span className="ml-0.5 text-white/30">{assigneeName}</span>}
                  </motion.button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Detects convoys where beads are open but no agents are assigned.
 */
export function StrandedConvoyAlert({ beads, onSling }: { beads: Bead[]; onSling?: () => void }) {
  const strandedBeads = beads.filter(b => b.status === 'open' && !b.assignee_agent_bead_id);

  if (strandedBeads.length === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-2.5">
      <AlertTriangle className="size-4 shrink-0 text-orange-400" />
      <div className="flex-1">
        <span className="text-xs font-medium text-orange-300">
          {strandedBeads.length} stranded bead{strandedBeads.length > 1 ? 's' : ''}
        </span>
        <span className="ml-1 text-[10px] text-orange-400/60">— open but no agent assigned</span>
      </div>
      {onSling && (
        <button
          onClick={onSling}
          className="rounded-md bg-orange-500/15 px-3 py-1 text-[10px] font-medium text-orange-300 transition-colors hover:bg-orange-500/25"
        >
          Sling
        </button>
      )}
    </div>
  );
}
