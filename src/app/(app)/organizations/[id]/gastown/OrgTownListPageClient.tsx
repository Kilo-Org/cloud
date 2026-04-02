'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { toast } from 'sonner';
import { GastownOverviewClient } from '@/components/gastown/GastownOverviewClient';

type OrgTownListPageClientProps = {
  organizationId: string;
  role: string;
};

export function OrgTownListPageClient({ organizationId, role }: OrgTownListPageClientProps) {
  const isOwner = role === 'owner';
  const trpc = useGastownTRPC();
  const onboardingUrl = `/gastown/onboarding?orgId=${encodeURIComponent(organizationId)}`;

  const queryClient = useQueryClient();
  const townsQuery = useQuery(trpc.gastown.listOrgTowns.queryOptions({ organizationId }));

  const deleteTown = useMutation(
    trpc.gastown.deleteOrgTown.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listOrgTowns.queryKey({ organizationId }),
        });
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
      onboardingUrl={onboardingUrl}
      onDeleteTown={isOwner ? (townId) => deleteTown.mutate({ organizationId, townId }) : undefined}
      title="Gas Town"
      description="A chat-first orchestration console for towns, rigs, beads, and agents. Built for radical transparency: every object is clickable; every outcome is attributable."
      organizationId={organizationId}
    />
  );
}
