'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateRigDialog } from '@/components/gastown/CreateRigDialog';
import { MayorChat } from '@/components/gastown/MayorChat';
import { ActivityFeedView } from '@/components/gastown/ActivityFeed';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { ArrowLeft, Plus, GitBranch, Trash2, Activity, Bot, Users } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

type TownOverviewPageClientProps = {
  townId: string;
};

export function TownOverviewPageClient({ townId }: TownOverviewPageClientProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const [isCreateRigOpen, setIsCreateRigOpen] = useState(false);

  const queryClient = useQueryClient();
  const townQuery = useQuery(trpc.gastown.getTown.queryOptions({ townId }));
  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const townEventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 80 }),
    refetchInterval: 5_000,
  });

  const escalationsCount = (townEventsQuery.data ?? []).filter(
    e => e.event_type === 'escalated'
  ).length;

  const deleteRig = useMutation(
    trpc.gastown.deleteRig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listRigs.queryKey() });
        toast.success('Rig deleted');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => void router.push('/gastown')}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white/85"
            >
              <ArrowLeft className="size-4" />
              Back to towns
            </button>

            <Button
              variant="primary"
              size="md"
              onClick={() => setIsCreateRigOpen(true)}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Rig
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              {townQuery.isLoading ? (
                <>
                  <Skeleton className="h-9 w-56" />
                  <Skeleton className="mt-2 h-4 w-40" />
                </>
              ) : (
                <>
                  <h1 className="text-3xl font-semibold tracking-tight text-balance text-white/95">
                    {townQuery.data?.name}
                  </h1>
                  <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                    Chat-first command center with radical transparency. Everything here is a live
                    object: rigs, agents, beads, events.
                  </p>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">Rigs</div>
                <div className="mt-0.5 text-lg font-semibold text-white/85">
                  {(rigsQuery.data ?? []).length}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">
                  Escalations
                </div>
                <div className="mt-0.5 text-lg font-semibold text-white/85">{escalationsCount}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">
                  Events (80)
                </div>
                <div className="mt-0.5 text-lg font-semibold text-white/85">
                  {townEventsQuery.isLoading ? '…' : (townEventsQuery.data ?? []).length}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[11px] tracking-wider text-white/40 uppercase">System</div>
                <div className="mt-1 inline-flex items-center gap-2 text-sm text-white/70">
                  <span className="size-2 rounded-full bg-emerald-400" />
                  Live
                </div>
              </div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-[color:oklch(95%_0.15_108_/_0.95)]" />
              <h2 className="text-sm font-medium tracking-wide text-white/70">Mayor</h2>
            </div>
            <p className="mt-0.5 text-xs text-white/45">
              The orchestrator. Describe intent; watch the machine route it into beads and agents.
            </p>
          </div>
          <GastownBackdrop>
            <div className="p-4">
              <MayorChat townId={townId} />
            </div>
          </GastownBackdrop>
        </div>

        <div className="space-y-4 lg:col-span-7">
          {/* Rig Cards */}
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-white/70">
              <Users className="size-4" />
              Rigs
            </h2>

            {rigsQuery.isLoading && (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Card key={i}>
                    <CardContent className="p-3">
                      <Skeleton className="h-5 w-40" />
                      <Skeleton className="mt-1.5 h-3.5 w-56" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {rigsQuery.data && rigsQuery.data.length === 0 && (
              <GastownBackdrop>
                <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <GitBranch className="size-9 text-white/40" />
                  <div>
                    <div className="text-sm font-medium text-white/75">No rigs yet</div>
                    <div className="mt-1 text-xs text-white/45">
                      Connect a repo to create a rig; agents will spawn inside the town container.
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsCreateRigOpen(true)}
                    className="gap-1 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
                  >
                    <Plus className="size-4" />
                    Create rig
                  </Button>
                </div>
              </GastownBackdrop>
            )}

            {rigsQuery.data && rigsQuery.data.length > 0 && (
              <div className="space-y-2">
                {rigsQuery.data.map(rig => (
                  <Card
                    key={rig.id}
                    className="cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color,transform] hover:bg-white/[0.05]"
                    onClick={() => void router.push(`/gastown/${townId}/rigs/${rig.id}`)}
                  >
                    <CardContent className="flex items-center justify-between p-3">
                      <div className="min-w-0">
                        <h3 className="font-medium text-white/85">{rig.name}</h3>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-white/55">
                          <span className="flex items-center gap-1">
                            <GitBranch className="size-3" />
                            {rig.default_branch}
                          </span>
                          <span className="max-w-[260px] truncate font-mono text-[11px] text-white/45">
                            {rig.git_url}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-white/45">
                          {formatDistanceToNow(new Date(rig.created_at), { addSuffix: true })}
                        </span>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            if (confirm(`Delete rig "${rig.name}"?`)) {
                              deleteRig.mutate({ rigId: rig.id });
                            }
                          }}
                          className="rounded p-1 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Activity Feed */}
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-white/70">
              <Activity className="size-4" />
              Activity
            </h2>
            <GastownBackdrop>
              <div className="p-0">
                <ActivityFeedView
                  townId={townId}
                  events={(townEventsQuery.data ?? []).slice(-50)}
                  isLoading={townEventsQuery.isLoading}
                />
              </div>
            </GastownBackdrop>
          </div>
        </div>
      </div>

      <CreateRigDialog
        townId={townId}
        isOpen={isCreateRigOpen}
        onClose={() => setIsCreateRigOpen(false)}
      />
    </PageContainer>
  );
}
