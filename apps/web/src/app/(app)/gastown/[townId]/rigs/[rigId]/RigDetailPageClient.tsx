'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { sortAgentsByStatus } from '@/lib/gastown/sort-agents';
import { toast } from 'sonner';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/ui/skeleton';
import { BeadBoard } from '@/components/gastown/BeadBoard';
import { AgentCard } from '@/components/gastown/AgentCard';
import { ConvoyTimeline } from '@/components/gastown/ConvoyTimeline';
import { CreateBeadDrawer } from '@/components/gastown/CreateBeadDrawer';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import {
  Plus,
  GitBranch,
  Hexagon,
  Bot,
  Layers,
  ChevronRight,
  ChevronDown,
  Settings,
} from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { motion, AnimatePresence } from 'motion/react';
import Link from 'next/link';

type RigDetailPageClientProps = {
  townId: string;
  rigId: string;
  basePath?: string;
};

export function RigDetailPageClient({
  townId,
  rigId,
  basePath: basePathOverride,
}: RigDetailPageClientProps) {
  const townBasePath = basePathOverride ?? `/gastown/${townId}`;
  const trpc = useGastownTRPC();
  const [isCreateBeadOpen, setIsCreateBeadOpen] = useState(false);
  const [convoysCollapsed, setConvoysCollapsed] = useState(false);
  const { open: openDrawer } = useDrawerStack();

  const queryClient = useQueryClient();
  const rigQuery = useQuery(trpc.gastown.getRig.queryOptions({ rigId }));
  const beadsQuery = useQuery({
    ...trpc.gastown.listBeads.queryOptions({ rigId }),
    refetchInterval: 8_000,
  });
  const agentsQuery = useQuery({
    ...trpc.gastown.listAgents.queryOptions({ rigId }),
    refetchInterval: 5_000,
  });

  const rig = rigQuery.data;

  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  const deleteBead = useMutation(
    trpc.gastown.deleteBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        toast.success('Bead deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const startBead = useMutation(
    trpc.gastown.startBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        toast.success('Bead started');
      },
      onError: err => toast.error(err.message),
    })
  );

  const deleteAgent = useMutation(
    trpc.gastown.deleteAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        toast.success('Agent deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const convoysQuery = useQuery({
    ...trpc.gastown.listConvoys.queryOptions({ townId }),
    refetchInterval: 8_000,
  });
  const closeConvoyMutation = useMutation(
    trpc.gastown.closeConvoy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listConvoys.queryKey({ townId }),
        });
      },
      onError: err => toast.error(err.message),
    })
  );
  const startConvoyMutation = useMutation(
    trpc.gastown.startConvoy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listConvoys.queryKey({ townId }),
        });
        toast.success('Convoy started');
      },
      onError: err => toast.error(err.message),
    })
  );

  const beads = beadsQuery.data ?? [];
  const agents = useMemo(() => sortAgentsByStatus(agentsQuery.data ?? []), [agentsQuery.data]);

  // Filter convoys to those with at least one bead in this rig
  const rigBeadIds = useMemo(() => new Set(beads.map(b => b.bead_id)), [beads]);
  const rigConvoys = useMemo(
    () =>
      (convoysQuery.data ?? []).filter(convoy => convoy.beads.some(b => rigBeadIds.has(b.bead_id))),
    [convoysQuery.data, rigBeadIds]
  );

  const openBeads = beads.filter(b => b.status === 'open' && b.type !== 'agent').length;
  const inProgressBeads = beads.filter(
    b => b.status === 'in_progress' && b.type !== 'agent'
  ).length;
  const inReviewBeads = beads.filter(b => b.status === 'in_review' && b.type !== 'agent').length;
  const closedBeads = beads.filter(b => b.status === 'closed' && b.type !== 'agent').length;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="-ml-3" />
          {rigQuery.isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-white/90">{rig?.name}</h1>
              {rig && (
                <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/40">
                  <GitBranch className="size-3" />
                  {rig.default_branch}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`${townBasePath}/rigs/${rigId}/settings`}
            className="flex items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/60"
            title="Rig settings"
          >
            <Settings className="size-4" />
          </Link>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsCreateBeadOpen(true)}
            className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
          >
            <Plus className="size-3.5" />
            New Bead
          </Button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-4 border-b border-white/[0.06]">
        <RigStatCell label="Open" value={openBeads} color="text-sky-400" />
        <RigStatCell label="In Progress" value={inProgressBeads} color="text-amber-400" />
        <RigStatCell label="In Review" value={inReviewBeads} color="text-purple-400" />
        <RigStatCell label="Closed" value={closedBeads} color="text-emerald-400" />
      </div>

      {/* Convoy progress (if any) */}
      {rigConvoys.length > 0 && (
        <div className="flex max-h-[40vh] flex-col border-b border-white/[0.06] px-4 py-3">
          <button
            onClick={() => setConvoysCollapsed(v => !v)}
            className="mb-2 flex w-full shrink-0 items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <Layers className="size-3 text-violet-400/70" />
              <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
                Convoys ({rigConvoys.length})
              </span>
            </div>
            {convoysCollapsed ? (
              <ChevronRight className="size-3.5 text-white/25" />
            ) : (
              <ChevronDown className="size-3.5 text-white/25" />
            )}
          </button>
          <div className="min-h-0 min-w-0 overflow-y-auto">
            <ConvoyTimeline
              convoys={rigConvoys}
              collapsed={convoysCollapsed}
              onSelectBead={(beadId, beadRigId) =>
                openDrawer({ type: 'bead', beadId, rigId: beadRigId ?? rigId })
              }
              onSelectConvoy={convoyId => openDrawer({ type: 'convoy', convoyId, townId })}
              onCloseConvoy={convoyId => closeConvoyMutation.mutate({ townId, convoyId })}
              onStartConvoy={convoyId => startConvoyMutation.mutate({ townId, convoyId })}
            />
          </div>
        </div>
      )}

      {/* Main content: columns layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Column 1: Bead Board */}
        <div className="flex flex-1 flex-col overflow-y-auto border-r border-white/[0.06]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
            <Hexagon className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
              Bead Board
            </span>
            <span className="ml-auto font-mono text-[10px] text-white/20">{beads.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <BeadBoard
              beads={beads}
              isLoading={beadsQuery.isLoading}
              onDeleteBead={beadId => {
                if (confirm('Delete this bead?')) {
                  deleteBead.mutate({ rigId, beadId });
                }
              }}
              onSelectBead={bead => openDrawer({ type: 'bead', beadId: bead.bead_id, rigId })}
              onStartBead={beadId => startBead.mutate({ rigId, beadId })}
              agentNameById={agentNameById}
            />
          </div>
        </div>

        {/* Column 2: Agent Roster */}
        <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
            <Bot className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
              Agents
            </span>
            <span className="ml-auto font-mono text-[10px] text-white/20">{agents.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {agentsQuery.isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-lg" />
                ))}
              </div>
            )}

            {agents.length === 0 && !agentsQuery.isLoading && (
              <div className="rounded-lg border border-dashed border-white/[0.08] p-4 text-center text-xs text-white/30">
                No agents yet. Sling work to spawn a polecat.
              </div>
            )}

            <AnimatePresence mode="popLayout">
              {agents.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ delay: i * 0.03, duration: 0.2 }}
                  className="mb-2"
                >
                  <AgentCard
                    agent={agent}
                    isSelected={false}
                    onSelect={() => openDrawer({ type: 'agent', agentId: agent.id, rigId, townId })}
                    onDelete={() => {
                      if (confirm(`Delete agent "${agent.name}"?`)) {
                        deleteAgent.mutate({ rigId, agentId: agent.id });
                      }
                    }}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <CreateBeadDrawer
        rigId={rigId}
        townId={townId}
        isOpen={isCreateBeadOpen}
        onClose={() => setIsCreateBeadOpen(false)}
      />
    </div>
  );
}

function RigStatCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border-r border-white/[0.06] px-4 py-2.5 last:border-r-0">
      <div className={`text-[10px] font-medium tracking-wide uppercase ${color} opacity-60`}>
        {label}
      </div>
      <motion.div
        key={value}
        initial={{ y: 4, opacity: 0.4 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="mt-0.5 font-mono text-lg font-semibold text-white/80"
      >
        {value}
      </motion.div>
    </div>
  );
}
