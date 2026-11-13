import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { getIntegrationPagePath, getIntegrationPageUrl } from '@/lib/integration-urls';
import { type IntegrationProvider, providerLabelKey } from '@/lib/integrations/provider-catalog';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * The scope's connections, from the same read the web integrations hub uses:
 * one call covers every platform's status and the account it names.
 */
export function useIntegrationStatuses(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  const input = organizationId ? { organizationId } : {};
  return useQuery({
    ...trpc.platformIntegrations.listSetupStatus.queryOptions(input, { enabled }),
  });
}

/**
 * GitHub connections, read only for the ids a setup-status row cannot carry:
 * disconnecting an organization installation names the connection it removes.
 */
export function useGitHubConnections(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  const input = organizationId ? { organizationId } : {};
  return useQuery({
    ...trpc.githubApps.listIntegrations.queryOptions(input, { enabled }),
  });
}

type DisconnectVariables = {
  provider: IntegrationProvider;
  /** The connection a GitHub organization install removes; unused elsewhere. */
  githubIntegrationId: string | null;
};

function disconnectIntegration(
  organizationId: string | undefined,
  { provider, githubIntegrationId }: DisconnectVariables
) {
  const input = organizationId ? { organizationId } : {};
  switch (provider) {
    case 'github': {
      if (!organizationId) {
        return trpcClient.githubApps.uninstallApp.mutate({});
      }
      if (!githubIntegrationId) {
        throw new Error('A GitHub connection id is required to disconnect an organization install');
      }
      return trpcClient.githubApps.uninstallApp.mutate({
        organizationId,
        integrationId: githubIntegrationId,
      });
    }
    case 'slack': {
      return trpcClient.slack.uninstallApp.mutate(input);
    }
    case 'linear': {
      return trpcClient.linear.uninstallApp.mutate(input);
    }
    case 'discord': {
      return trpcClient.discord.uninstallApp.mutate(input);
    }
    case 'gitlab': {
      return trpcClient.gitlab.disconnect.mutate(input);
    }
    case 'bitbucket': {
      // Bitbucket's controls live on the web page; its row never offers this.
      throw new Error('Bitbucket connections are changed on the web');
    }
    default: {
      throw new Error(`Unsupported integration: ${String(provider)}`);
    }
  }
}

/**
 * Disconnects one provider. The server owns the role rules (organization
 * manager or billing authority, per platform), so a rejected action surfaces
 * its own explanation instead of a generic failure.
 */
export function useDisconnectIntegration(organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : {};

  return useMutation({
    mutationFn: (variables: DisconnectVariables) =>
      disconnectIntegration(organizationId, variables),
    onSuccess: async (_result, variables) => {
      announcingToast.success(
        i18n.t('integrations.disconnected', {
          provider: i18n.t(providerLabelKey(variables.provider)),
        })
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.platformIntegrations.listSetupStatus.queryKey(input),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(input),
        }),
      ]);
    },
    onError: (error, variables) => {
      announcingToast.error(
        knownServerErrorMessage(error) ??
          i18n.t('integrations.disconnectFailed', {
            provider: i18n.t(providerLabelKey(variables.provider)),
          })
      );
    },
  });
}

/**
 * The provider's connect URL. OAuth callbacks land on the web, so every
 * provider is connected there; GitHub additionally validates a one-time install
 * state token, which the minted URL carries.
 */
async function connectUrl(
  provider: IntegrationProvider,
  organizationId: string | undefined
): Promise<string> {
  if (provider !== 'github') {
    return getIntegrationPageUrl(WEB_BASE_URL, provider, organizationId);
  }
  const { token } = await trpcClient.githubApps.mintInstallState.mutate({
    ...(organizationId ? { organizationId } : {}),
    returnTo: getIntegrationPagePath('github', organizationId),
  });
  return getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token);
}

/**
 * Opens the web page that owns a provider's connect flow and waits for the
 * return to the app, then refreshes the caller's reads. The browser session is
 * the app's existing hand-off (`connect-gate-platform`): a launch the app never
 * saw still reaches the caller through `reportLateLaunchFailure`.
 */
export function useIntegrationConnect(params: {
  organizationId?: string;
  onReturned: () => Promise<void>;
}) {
  const [pendingProvider, setPendingProvider] = useState<IntegrationProvider | null>(null);

  async function connect(provider: IntegrationProvider) {
    setPendingProvider(provider);
    try {
      const url = await connectUrl(provider, params.organizationId);
      const wait = await openAuthorizationAndWaitForReturn(url);
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          announcingToast.error(i18n.t('integrations.connectFailed'));
        },
      });
      await params.onReturned();
    } catch (error) {
      announcingToast.error(knownServerErrorMessage(error) ?? i18n.t('integrations.connectFailed'));
    } finally {
      setPendingProvider(null);
    }
  }

  return { pendingProvider, connect };
}
