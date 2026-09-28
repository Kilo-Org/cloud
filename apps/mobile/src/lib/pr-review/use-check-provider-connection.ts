// Provider-aware connection check for the PR-review connect gate.
//
// `useCheckGitHubConnection` stays the GitHub arm (it refetches the GitHub
// App user authorization and invalidates `githubPrReview`). GitLab and
// Bitbucket have no per-user GitHub authorization to check — their
// connectivity is the integration status the s4 endpoints expose
// (`getGitLabStatus` personal + org, `getBitbucketReadiness` org), so this
// hook force-refetches that status and invalidates `providerReview` once the
// provider answers connected.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

type ProviderConnectionPlatform = 'gitlab' | 'bitbucket';

export type CheckProviderConnectionInput = {
  platform: ProviderConnectionPlatform;
  /** The selected organization, or null for the personal scope. */
  organizationId: string | null;
};

/**
 * Force-fresh provider connection check. Bitbucket Cloud is
 * organization-context only, so a personal scope has nothing to check and
 * the mutation reports not-connected without a call.
 */
export function useCheckProviderConnection() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation({
    mutationFn: async (input: CheckProviderConnectionInput) => {
      if (input.platform === 'bitbucket' && !input.organizationId) {
        return { connected: false };
      }
      // The two providers answer with different status shapes, so each arm
      // fetches its own options — a union of the two queryOptions types is
      // not assignable to a single fetchQuery call.
      const status =
        input.platform === 'gitlab'
          ? await queryClient.fetchQuery({
              ...(input.organizationId
                ? trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({
                    organizationId: input.organizationId,
                  })
                : trpc.personalReviewAgent.getGitLabStatus.queryOptions()),
              staleTime: 0,
            })
          : await queryClient.fetchQuery({
              ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
                organizationId: input.organizationId ?? '',
              }),
              staleTime: 0,
            });
      if (status.connected) {
        await queryClient.invalidateQueries(trpc.providerReview.pathFilter());
      }
      return status;
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}
