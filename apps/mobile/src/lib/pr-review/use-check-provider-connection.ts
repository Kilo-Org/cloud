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
 * What the check learned. `connected` is whether the provider answered a live
 * connection; `instanceUrl` is the GitLab instance that connection serves, so
 * the caller can tell a connection to *another* instance from one that can
 * read the opened merge request — the same comparison the review read makes on
 * the server. Bitbucket Cloud has one host, so its answer never carries one.
 */
export type ProviderConnectionStatus = {
  readonly connected: boolean;
  readonly instanceUrl: string | null;
};

/**
 * Force-fresh provider connection check. Bitbucket Cloud is
 * organization-context only, so a personal scope has nothing to check and
 * the mutation reports not-connected without a call.
 */
export function useCheckProviderConnection() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const fetchProviderStatus = async (
    input: CheckProviderConnectionInput
  ): Promise<ProviderConnectionStatus> => {
    if (input.platform === 'gitlab') {
      if (input.organizationId) {
        const status = await queryClient.query({
          ...trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({
            organizationId: input.organizationId,
          }),
          staleTime: 0,
        });
        return {
          connected: status.connected,
          instanceUrl: status.integration?.instanceUrl ?? null,
        };
      }
      const status = await queryClient.query({
        ...trpc.personalReviewAgent.getGitLabStatus.queryOptions(),
        staleTime: 0,
      });
      return {
        connected: status.connected,
        instanceUrl: status.integration?.instanceUrl ?? null,
      };
    }
    if (!input.organizationId) {
      return { connected: false, instanceUrl: null };
    }
    const status = await queryClient.query({
      ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
        organizationId: input.organizationId,
      }),
      staleTime: 0,
    });
    // Bitbucket Cloud is a single host, so there is no instance to name.
    return { connected: status.connected, instanceUrl: null };
  };

  return useMutation({
    mutationFn: async (input: CheckProviderConnectionInput) => {
      const status = await fetchProviderStatus(input);
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
