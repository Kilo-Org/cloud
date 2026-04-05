'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useCustomLlms() {
  const trpc = useTRPC();
  return useQuery(trpc.admin.customLlm.list.queryOptions());
}

export function useUpsertCustomLlm() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.customLlm.upsert.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.customLlm.list.queryKey(),
        });
      },
    })
  );
}

export function useDeleteCustomLlm() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.customLlm.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.customLlm.list.queryKey(),
        });
      },
    })
  );
}
