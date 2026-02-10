'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useAlertingConfigs() {
  const trpc = useTRPC();
  return useQuery(trpc.admin.alerting.listConfigs.queryOptions());
}

export function useUpdateAlertingConfig() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.alerting.updateConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.alerting.listConfigs.queryKey(),
        });
      },
    })
  );
}

export function useAlertingBaseline() {
  const trpc = useTRPC();
  return useMutation(trpc.admin.alerting.getBaseline.mutationOptions());
}

export function useDeleteAlertingConfig() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.alerting.deleteConfig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.alerting.listConfigs.queryKey(),
        });
      },
    })
  );
}
