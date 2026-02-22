'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/ui/skeleton';
import { BeadBoard } from '@/components/gastown/BeadBoard';
import { AgentCard } from '@/components/gastown/AgentCard';
import { AgentStream } from '@/components/gastown/AgentStream';
import { SlingDialog } from '@/components/gastown/SlingDialog';
import { MayorChat } from '@/components/gastown/MayorChat';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { GastownBeadDetailSheet } from '@/components/gastown/GastownBeadDetailSheet';
import { ArrowLeft, Plus, GitBranch } from 'lucide-react';

type RigDetailPageClientProps = {
  townId: string;
  rigId: string;
};

export function RigDetailPageClient({ townId, rigId }: RigDetailPageClientProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const [isSlingOpen, setIsSlingOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedBeadId, setSelectedBeadId] = useState<string | null>(null);

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

  const selectedBead = (beadsQuery.data ?? []).find(b => b.bead_id === selectedBeadId) ?? null;

  const deleteBead = useMutation(
    trpc.gastown.deleteBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        toast.success('Bead deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const deleteAgent = useMutation(
    trpc.gastown.deleteAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        setSelectedAgentId(null);
        toast.success('Agent deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => void router.push(`/gastown/${townId}`)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white/85"
            >
              <ArrowLeft className="size-4" />
              Back to town
            </button>

            <Button
              variant="primary"
              size="md"
              onClick={() => setIsSlingOpen(true)}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              Sling Work
            </Button>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {rigQuery.isLoading ? (
                <>
                  <Skeleton className="h-9 w-56" />
                  <Skeleton className="mt-2 h-4 w-80" />
                </>
              ) : (
                <>
                  <h1 className="text-3xl font-semibold tracking-tight text-balance text-white/95">
                    {rig?.name}
                  </h1>
                  {rig && (
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-white/60">
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                        <GitBranch className="size-3.5" />
                        {rig.default_branch}
                      </span>
                      <span className="max-w-[560px] truncate rounded-full border border-white/10 bg-black/25 px-3 py-1 font-mono text-[12px] text-white/55">
                        {rig.git_url}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="hidden shrink-0 items-center gap-3 lg:flex">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">Beads</div>
                <div className="mt-0.5 text-sm font-medium text-white/80">
                  {(beadsQuery.data ?? []).length}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">Agents</div>
                <div className="mt-0.5 text-sm font-medium text-white/80">
                  {(agentsQuery.data ?? []).length}
                </div>
              </div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-white/70">Bead Board</h2>
              <p className="mt-0.5 text-xs text-white/45">
                Read-only kanban view with click-through details.
              </p>
            </div>
            <div className="hidden text-xs text-white/45 md:block">
              Tip: click a bead to open the ledger.
            </div>
          </div>

          <GastownBackdrop>
            <div className="p-4">
              <BeadBoard
                beads={beadsQuery.data ?? []}
                isLoading={beadsQuery.isLoading}
                onDeleteBead={beadId => {
                  if (confirm('Delete this bead?')) {
                    deleteBead.mutate({ rigId, beadId });
                  }
                }}
                onSelectBead={bead => {
                  setSelectedBeadId(bead.bead_id);
                }}
                selectedBeadId={selectedBeadId}
                agentNameById={agentNameById}
              />
            </div>
          </GastownBackdrop>
        </div>

        <div className="lg:col-span-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium tracking-wide text-white/70">Agent Roster</h2>
            <p className="mt-0.5 text-xs text-white/45">
              Live identities with hook + last activity.
            </p>
          </div>

          <GastownBackdrop>
            <div className="p-4">
              {agentsQuery.isLoading && (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-full rounded-lg" />
                  ))}
                </div>
              )}

              {agentsQuery.data && agentsQuery.data.length === 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-white/55">
                  No agents yet. Sling work to spawn a polecat.
                </div>
              )}

              {agentsQuery.data && agentsQuery.data.length > 0 && (
                <div className="space-y-3">
                  {agentsQuery.data.map(agent => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      isSelected={selectedAgentId === agent.id}
                      onSelect={() =>
                        setSelectedAgentId(prev => (prev === agent.id ? null : agent.id))
                      }
                      onDelete={() => {
                        if (confirm(`Delete agent "${agent.name}"?`)) {
                          deleteAgent.mutate({ rigId, agentId: agent.id });
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </GastownBackdrop>
        </div>
      </div>

      {/* Agent Stream */}
      {selectedAgentId && (
        <div className="mt-6">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-white/70">Agent Stream</h2>
              <p className="mt-0.5 text-xs text-white/45">
                Real-time tool calls, diffs, and narrative output.
              </p>
            </div>
          </div>
          <AgentStream
            townId={townId}
            agentId={selectedAgentId}
            onClose={() => setSelectedAgentId(null)}
          />
        </div>
      )}

      {/* Mayor Chat */}
      <div className="mt-6">
        <div className="mb-3">
          <h2 className="text-sm font-medium tracking-wide text-white/70">Mayor Chat</h2>
          <p className="mt-0.5 text-xs text-white/45">
            Delegate work to the town-level coordinator.
          </p>
        </div>
        <GastownBackdrop>
          <div className="p-4">
            <MayorChat townId={townId} />
          </div>
        </GastownBackdrop>
      </div>

      <GastownBeadDetailSheet
        open={Boolean(selectedBeadId)}
        onOpenChange={open => {
          if (!open) setSelectedBeadId(null);
        }}
        bead={selectedBead}
        rigId={rigId}
        agentNameById={agentNameById}
        onDelete={
          selectedBead
            ? () => {
                if (confirm('Delete this bead?')) {
                  deleteBead.mutate({ rigId, beadId: selectedBead.bead_id });
                  setSelectedBeadId(null);
                }
              }
            : undefined
        }
      />

      <SlingDialog rigId={rigId} isOpen={isSlingOpen} onClose={() => setIsSlingOpen(false)} />
    </PageContainer>
  );
}
