import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

export function useCheckGitHubConnection() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation({
    mutationFn: async () => {
      const authorization = await queryClient.query({
        ...trpc.githubApps.getUserAuthorization.queryOptions(),
        staleTime: 0,
      });
      if (authorization.connected) {
        await queryClient.invalidateQueries(trpc.githubPrReview.pathFilter());
      }
      // The settled answer is what a calling surface clears its own recovery
      // state with: a connection that still answers cannot explain a latch the
      // surface raised when the connection had expired.
      return { connected: authorization.connected };
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}
