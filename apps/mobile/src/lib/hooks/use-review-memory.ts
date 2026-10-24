import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Review memory only exists for GitHub, so the owner input pins the platform
// and only varies the scope segment (personal vs. an organization id).
function reviewMemoryOwnerInput(scope: string) {
  return scope === PERSONAL_SCOPE
    ? { platform: 'github' as const }
    : { organizationId: scope, platform: 'github' as const };
}

export function useSetReviewMemoryEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ownerInput = reviewMemoryOwnerInput(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (enabled: boolean) =>
      trpcClient.reviewMemory.setEnabled.mutate({ ...ownerInput, enabled }),
    onSuccess: data => {
      // The stored value is authoritative, so write it into the cached summary
      // as soon as the mutation settles: the switch and the screen's state
      // branch read one source, and the refetch below replaces it with the
      // server's answer instead of a value that outlives the request.
      queryClient.setQueryData(
        trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
        previous => (previous ? { ...previous, enabled: data.enabled } : previous)
      );
      void queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      });
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}
