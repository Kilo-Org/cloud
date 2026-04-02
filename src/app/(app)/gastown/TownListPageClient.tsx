'use client';

import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { toast } from 'sonner';
import { GastownOverviewClient } from '@/components/gastown/GastownOverviewClient';

export function TownListPageClient() {
  const router = useRouter();
  const trpc = useGastownTRPC();

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
    <GastownOverviewClient
      towns={townsQuery.data ?? []}
      onboardingUrl="/gastown/onboarding"
      onDeleteTown={(townId) => deleteTown.mutate({ townId })}
      title="Gas Town"
      description="A chat-first orchestration console for towns, rigs, beads, and agents. Built for radical transparency: every object is clickable; every outcome is attributable."
    />
  );
}
