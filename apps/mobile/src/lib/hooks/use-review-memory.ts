import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { reviewMemoryOwnerInput } from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

export function useSetReviewMemoryEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ownerInput = reviewMemoryOwnerInput(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (enabled: boolean) =>
      trpcClient.reviewMemory.setEnabled.mutate({ ...ownerInput, enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      });
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}
