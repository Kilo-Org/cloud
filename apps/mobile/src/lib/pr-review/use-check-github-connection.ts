import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

export function useCheckGitHubConnection() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation({
    mutationFn: async () => {
      const authorization = await queryClient.fetchQuery({
        ...trpc.githubApps.getUserAuthorization.queryOptions(),
        staleTime: 0,
      });
      if (authorization.connected) {
        await queryClient.invalidateQueries(trpc.githubPrReview.pathFilter());
      }
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}
