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
import { isTrpcClientError, readTrpcErrorField } from '@/lib/trpc-error';

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
  /** The connection the provider's disconnect procedure removes. */
  integrationId: string | null;
};

async function disconnectIntegration(
  organizationId: string | undefined,
  { provider, integrationId }: DisconnectVariables
): Promise<void> {
  const input = organizationId ? { organizationId } : {};
  switch (provider) {
    case 'github': {
      if (!organizationId) {
        await trpcClient.githubApps.uninstallApp.mutate({});
        return;
      }
      if (!integrationId) {
        throw new Error('A GitHub connection id is required to disconnect an organization install');
      }
      await trpcClient.githubApps.uninstallApp.mutate({ organizationId, integrationId });
      return;
    }
    case 'slack': {
      await trpcClient.slack.uninstallApp.mutate(input);
      return;
    }
    case 'linear': {
      await trpcClient.linear.uninstallApp.mutate(input);
      return;
    }
    case 'discord': {
      await trpcClient.discord.uninstallApp.mutate(input);
      return;
    }
    case 'gitlab': {
      await trpcClient.gitlab.disconnect.mutate(input);
      return;
    }
    case 'bitbucket': {
      if (!organizationId) {
        throw new Error('Bitbucket connects an organization, never a personal account');
      }
      if (!integrationId) {
        throw new Error('A Bitbucket integration id is required to disconnect');
      }
      await trpcClient.organizations.bitbucket.disconnect.mutate({
        organizationId,
        integrationId,
      });
      return;
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
        // Bitbucket's own reads name the connection and the repositories it
        // served, and the code reviewer's readiness follows the same change.
        ...(organizationId
          ? [
              queryClient.invalidateQueries({
                queryKey: trpc.organizations.bitbucket.getStatus.queryKey({ organizationId }),
              }),
              queryClient.invalidateQueries({
                queryKey: trpc.organizations.reviewAgent.getBitbucketReadiness.queryKey({
                  organizationId,
                }),
              }),
              queryClient.invalidateQueries({
                queryKey: trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
                  organizationId,
                  forceRefresh: false,
                }),
              }),
            ]
          : []),
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
 * The provider's connect URL. OAuth callbacks land on the web, so Slack, Linear
 * and Discord connect there; GitHub additionally validates a one-time install
 * state token, which the minted URL carries. GitLab's PAT connect stays on the
 * web page for now. Bitbucket never reaches this function: its workspace access
 * token is pasted in the app's own connect sheet. An organization whose mint is
 * refused still gets the page, without the token, because the page mints its
 * own state for the signed-in web user.
 */
async function connectUrl(
  provider: WebConnectProvider,
  organizationId: string | undefined
): Promise<string> {
  if (provider !== 'github') {
    return getIntegrationPageUrl(WEB_BASE_URL, provider, organizationId);
  }
  try {
    const { token } = await trpcClient.githubApps.mintInstallState.mutate({
      ...(organizationId ? { organizationId } : {}),
      returnTo: getIntegrationPagePath('github', organizationId),
    });
    return getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token);
  } catch (error) {
    // An organization's mint needs `OWNER`/`ADMIN` and refuses everyone else
    // with `UNAUTHORIZED`; a non-multi-installation organization that already
    // has an active GitHub App connection is refused with `FORBIDDEN`. Neither
    // can mint a token, and the page still works without one: it mints its own
    // state for the signed-in web user. Both therefore open that page instead
    // of an error toast, which would leave the row inert in exactly the state
    // that needs a route to it. A non-tRPC rejection can carry a bare `code`, so
    // only a real client error counts.
    const code = readTrpcErrorField(error, 'code');
    if (
      organizationId &&
      isTrpcClientError(error) &&
      (code === 'FORBIDDEN' || code === 'UNAUTHORIZED')
    ) {
      return getGitHubIntegrationUrl(WEB_BASE_URL, organizationId);
    }
    throw error;
  }
}

/** The providers whose connect flow still starts on the web page. */
type WebConnectProvider = Exclude<IntegrationProvider, 'bitbucket'>;

/**
 * The hub's Connect action: the provider whose launch is in flight, and the tap
 * that starts one. Bitbucket is not among them — its workspace access token is
 * pasted in the app's own connect sheet, so it never reaches the browser
 * hand-off.
 */
export type IntegrationConnect = {
  pendingProvider: WebConnectProvider | null;
  connect: (provider: WebConnectProvider) => Promise<void>;
};

/**
 * Opens the web page that owns a provider's connect flow and waits for the
 * return to the app, then refreshes the caller's reads. The browser session is
 * the app's existing hand-off (`connect-gate-platform`): a launch the app never
 * saw still reaches the caller through `reportLateLaunchFailure`. The hub calls
 * it only for the providers that still connect on the web; Bitbucket opens the
 * app's own connect sheet instead.
 */
export function useIntegrationConnect(params: {
  organizationId?: string;
  onReturned: () => Promise<void>;
}): IntegrationConnect {
  const [pendingProvider, setPendingProvider] = useState<WebConnectProvider | null>(null);

  async function connect(provider: WebConnectProvider) {
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
