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
