import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { isPersonal } from '@/lib/code-reviewer-config';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Bitbucket is org-only, so unlike the GitHub/GitLab status hooks there is no
// personal-vs-org split here.

export function useBitbucketReadiness(scope: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonal(scope),
  });
}

export function useConnectBitbucket(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.organizations.reviewAgent.getBitbucketReadiness.queryKey({
    organizationId: scope,
  });

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { accessToken: string }) =>
      trpcClient.organizations.bitbucket.connect.mutate({
        organizationId: scope,
        accessToken: vars.accessToken,
      }),
    onError: error => {
      announcingToast.error(error.message);
    },
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}
