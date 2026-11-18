import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';

/**
 * Hook for fetching and managing webhook triggers.
 * Handles list query and delete mutation with cache invalidation.
 */
export function useWebhookTriggers(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery(
    trpc.webhookTriggers.list.queryOptions({
      organizationId: organizationId ?? undefined,
    })
  );

  const deleteMutation = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Trigger deleted successfully');
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
      },
      onError: err => {
        toast.error(`Failed to delete trigger: ${err.message}`);
      },
    })
  );

  const deleteTrigger = (triggerId: string) => {
    deleteMutation.mutate({
      triggerId,
      organizationId: organizationId ?? undefined,
    });
  };

  return {
    triggers: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    deleteTrigger,
    isDeleting: deleteMutation.isPending,
  };
}

export function useInvokeWebhookTrigger(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invocationInFlightRef = useRef(false);
  const [invokingTriggerId, setInvokingTriggerId] = useState<string | null>(null);

  const invokeMutation = useMutation({
    ...trpc.webhookTriggers.invoke.mutationOptions({
      onSuccess: () => {
        toast.success('Run queued');
      },
      onError: error => {
        toast.error(`Failed to queue run: ${error.message}`);
      },
      onSettled: (_data, _error, variables) => {
        invocationInFlightRef.current = false;
        setInvokingTriggerId(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.webhookTriggers.listRequests.queryKey({
            triggerId: variables.triggerId,
            organizationId: variables.organizationId,
          }),
        });
      },
    }),
    retry: false,
  });

  const invokeTrigger = useCallback(
    async (triggerId: string) => {
      if (invocationInFlightRef.current) return;

      invocationInFlightRef.current = true;
      setInvokingTriggerId(triggerId);
      return await invokeMutation.mutateAsync({
        triggerId,
        organizationId: organizationId ?? undefined,
      });
    },
    [invokeMutation, organizationId]
  );

  return {
    invokeTrigger,
    isInvoking: invokeMutation.isPending,
    invokingTriggerId,
  };
}
