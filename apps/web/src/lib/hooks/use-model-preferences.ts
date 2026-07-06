'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

// Web only consumes the last-selected part of the shared preferences today;
// favorites mutations live in the mobile hook and can be added here when web
// grows a favorites UI.
export function useModelPreferences(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery(
    trpc.modelPreferences.get.queryOptions(organizationId ? { organizationId } : undefined)
  );

  const setLastSelected = useMutation(
    trpc.modelPreferences.setLastSelected.mutationOptions({
      // Partial key (no input) so org-scoped and org-less caches both refresh.
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.modelPreferences.get.queryKey() }),
      onError,
    })
  );

  return {
    lastSelected: query.data?.lastSelected ?? null,
    setLastSelected: setLastSelected.mutate,
  };
}
