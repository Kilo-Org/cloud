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

  const queryClient = useQueryClient();
  const rigQuery = useQuery(trpc.gastown.getRig.queryOptions({ rigId }));
  const beadsQuery = useQuery(trpc.gastown.listBeads.queryOptions({ rigId }));
  const agentsQuery = useQuery(trpc.gastown.listAgents.queryOptions({ rigId }));

  const rig = rigQuery.data;

  const deleteBead = useMutation(
    trpc.gastown.deleteBead.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        toast.success('Bead deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const deleteAgent = useMutation(
    trpc.gastown.deleteAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        setSelectedAgentId(null);
        toast.success('Agent deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  return (
    <PageContainer>
      <div className="mb-8">
        <button
          onClick={() => router.push(`/gastown/${townId}`)}
          className="mb-4 flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft className="size-4" />
          Back to town
        </button>

        <div className="flex items-center justify-between">
          <div>
            {rigQuery.isLoading ? (
              <>
                <Skeleton className="h-8 w-48" />
                <Skeleton className="mt-2 h-4 w-64" />
              </>
            ) : (
              <>
                <h1 className="text-3xl font-bold text-gray-100">{rig?.name}</h1>
                {rig && (
                  <div className="mt-1 flex items-center gap-3 text-sm text-gray-400">
                    <span className="flex items-center gap-1">
                      <GitBranch className="size-3.5" />
                      {rig.default_branch}
                    </span>
                    <span className="max-w-sm truncate">{rig.git_url}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsSlingOpen(true)}
            className="gap-2"
          >
            <Plus className="size-5" />
            Sling Work
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Bead Board — takes 2 columns */}
        <div className="lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-gray-200">Beads</h2>
          <BeadBoard
            beads={beadsQuery.data ?? []}
            isLoading={beadsQuery.isLoading}
            onDeleteBead={beadId => {
              if (confirm('Delete this bead?')) {
                deleteBead.mutate({ rigId, beadId });
              }
            }}
          />
        </div>

        {/* Agents sidebar */}
        <div>
          <h2 className="mb-4 text-lg font-semibold text-gray-200">Agents</h2>
          {agentsQuery.isLoading && (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          )}
          {agentsQuery.data && agentsQuery.data.length === 0 && (
            <p className="text-sm text-gray-500">No agents yet. Sling work to create one.</p>
          )}
          {agentsQuery.data && agentsQuery.data.length > 0 && (
            <div className="space-y-3">
              {agentsQuery.data.map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isSelected={selectedAgentId === agent.id}
                  onSelect={() => setSelectedAgentId(prev => (prev === agent.id ? null : agent.id))}
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
      </div>

      {/* Agent Stream */}
      {selectedAgentId && (
        <div className="mt-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-200">Agent Stream</h2>
          <AgentStream
            townId={townId}
            agentId={selectedAgentId}
            onClose={() => setSelectedAgentId(null)}
          />
        </div>
      )}

      {/* Mayor Chat */}
      <div className="mt-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-200">Mayor Chat</h2>
        <MayorChat townId={townId} onMayorAgentId={agentId => setSelectedAgentId(agentId)} />
      </div>

      <SlingDialog rigId={rigId} isOpen={isSlingOpen} onClose={() => setIsSlingOpen(false)} />
    </PageContainer>
  );
}
