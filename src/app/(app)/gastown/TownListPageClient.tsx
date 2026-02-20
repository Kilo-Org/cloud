'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateTownDialog } from '@/components/gastown/CreateTownDialog';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { Plus, Factory, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

export function TownListPageClient() {
  const router = useRouter();
  const trpc = useTRPC();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const queryClient = useQueryClient();
  const townsQuery = useQuery(trpc.gastown.listTowns.queryOptions());

  const deleteTown = useMutation(
    trpc.gastown.deleteTown.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listTowns.queryKey() });
        toast.success('Town deleted');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-semibold tracking-tight text-white/95">Gastown</h1>
                <Badge variant="beta">beta</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                A chat-first orchestration console for towns, rigs, beads, and agents. Built for
                radical transparency: every object is clickable; every outcome is attributable.
              </p>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => setIsCreateOpen(true)}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Town
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Towns</div>
              <div className="mt-0.5 text-lg font-semibold text-white/85">
                {townsQuery.isLoading ? '…' : (townsQuery.data ?? []).length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Mode</div>
              <div className="mt-1 inline-flex items-center gap-2 text-sm text-white/70">
                <span className="size-2 rounded-full bg-emerald-400" />
                Live
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Core</div>
              <div className="mt-1 text-sm text-white/70">MEOW · GUPP · NDI</div>
            </div>
            <div className="hidden rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 sm:block">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Promise</div>
              <div className="mt-1 text-sm text-white/70">Discover, don’t track</div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      {townsQuery.isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-white/10 bg-white/[0.03]">
              <CardContent className="p-4">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="mt-2 h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {townsQuery.data && townsQuery.data.length === 0 && (
        <GastownBackdrop>
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <Factory className="mb-4 size-12 text-white/40" />
            <h3 className="text-lg font-semibold text-white/85">No towns yet</h3>
            <p className="mt-2 max-w-md text-sm text-white/55">
              Create a town to spawn the Mayor and begin delegating work. Your town becomes the
              command center for every rig.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={() => setIsCreateOpen(true)}
              className="mt-5 gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              Create your first town
            </Button>
          </div>
        </GastownBackdrop>
      )}

      {townsQuery.data && townsQuery.data.length > 0 && (
        <div className="space-y-3">
          {townsQuery.data.map(town => (
            <Card
              key={town.id}
              className="cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color,transform] hover:bg-white/[0.05]"
              onClick={() => void router.push(`/gastown/${town.id}`)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <h3 className="text-lg font-medium text-white/90">{town.name}</h3>
                  <p className="text-sm text-white/50">
                    Created {formatDistanceToNow(new Date(town.created_at), { addSuffix: true })}
                  </p>
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (
                      confirm(`Delete town "${town.name}"? This will also delete all its rigs.`)
                    ) {
                      deleteTown.mutate({ townId: town.id });
                    }
                  }}
                  className="rounded p-1.5 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="size-4" />
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateTownDialog isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </PageContainer>
  );
}
