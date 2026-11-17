import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  type IntegrationScope,
  visibleIntegrationProviders,
} from '@/lib/integrations/provider-catalog';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type IntegrationSetupStatus =
  RouterOutputs['platformIntegrations']['listSetupStatus'][number];
export type IntegrationGitHubConnection = RouterOutputs['githubApps']['listIntegrations'][number];

export type IntegrationRow = {
  provider: IntegrationProvider;
  installed: boolean;
  /** The account, workspace or guild the status read named, when it named one. */
  accountLabel: string | null;
  /**
   * The connection a native disconnect removes: the GitHub installation the
   * row names, or the Bitbucket integration. Null when the hub cannot name
   * exactly one connection, and the row must not offer a Disconnect the server
   * would refuse.
   */
  disconnectIntegrationId: string | null;
  /**
   * Whether the row can disconnect natively. GitHub's and Bitbucket's
   * procedures name the connection they remove, so they need
   * {@link disconnectIntegrationId}; every other provider's procedure takes the
   * organization alone and needs no id.
   */
  canDisconnectNatively: boolean;
  /**
   * The platform's connection can only be changed on the web: several GitHub
   * installations are ambiguous in a single row. Bitbucket is not here — its
   * workspace access token is pasted in the app's own connect sheet.
   */
  webManaged: boolean;
  /**
   * The read that names the disconnect target has not settled, so the row has
   * no action yet. An unread list is not an empty one: the personal scope needs
   * no id for `githubApps.uninstallApp({})`, and the organization scope cannot
   * tell a native disconnect from the web page until it lands.
   */
  actionPending: boolean;
};

/**
 * The account field each provider's setup status fills. Mirrors
 * `buildInstallationSummary` in apps/web's platform-integration-setup-status.
 */
const ACCOUNT_FIELD = {
  github: 'accountLogin',
  gitlab: 'accountLogin',
  bitbucket: 'accountLogin',
  slack: 'teamName',
  discord: 'guildName',
  linear: 'workspaceName',
} satisfies Record<IntegrationProvider, keyof NonNullable<IntegrationSetupStatus['installation']>>;

function isActiveGitHubConnection(connection: IntegrationGitHubConnection): boolean {
  return connection.integration_status === 'active' && connection.suspended_at == null;
}

/**
 * One row per provider the scope offers, from the single setup-status read the
 * web hub uses, plus the two reads that name a connection the setup status
 * cannot carry: the GitHub installations and the organization's Bitbucket
 * integration.
 */
export function buildIntegrationRows(input: {
  scope: IntegrationScope;
  statuses: readonly IntegrationSetupStatus[];
  githubConnections: readonly IntegrationGitHubConnection[];
  /**
   * Whether the connections read is still in flight. Omit it once the read has
   * settled, which is what a caller holding `data` has.
   */
  githubConnectionsPending?: boolean;
  /**
   * The organization's Bitbucket integration id, or null when the
   * organization has none (or the read failed). Absent for a personal scope.
   */
  bitbucketIntegrationId?: string | null;
  /** Whether that Bitbucket read has not settled yet. */
  bitbucketIntegrationPending?: boolean;
}): IntegrationRow[] {
  const statusByPlatform = new Map(input.statuses.map(status => [status.platform, status]));
  const installed: Partial<Record<IntegrationProvider, boolean>> = {};
  for (const provider of INTEGRATION_PROVIDERS) {
    installed[provider] = statusByPlatform.get(provider)?.installed === true;
  }

  const activeGitHub = input.githubConnections.filter(isActiveGitHubConnection);
  // `uninstallApp` only accepts a `workflow`-role connection whose installation
  // has no other locally connected association; the read reports that verdict
  // per connection, so anything else goes to the web page instead of a
  // Disconnect the server would refuse.
  const githubConnection =
    activeGitHub.length === 1 && activeGitHub[0]?.canUninstallNatively === true
      ? activeGitHub[0]
      : null;

  return visibleIntegrationProviders(input.scope, installed).map(provider => {
    const status = statusByPlatform.get(provider);
    const connected = status?.installed === true;
    // A disconnected row can connect without the read that names its
    // connection; a connected one is the row that read exists for.
    const actionPending =
      connected &&
      ((provider === 'github' && input.githubConnectionsPending === true) ||
        (provider === 'bitbucket' && input.bitbucketIntegrationPending === true));
    let disconnectIntegrationId: string | null = null;
    if (provider === 'github') {
      disconnectIntegrationId = githubConnection?.id ?? null;
    } else if (provider === 'bitbucket') {
      disconnectIntegrationId = input.bitbucketIntegrationId ?? null;
    }
    // Only GitHub's and Bitbucket's procedures name the connection they remove.
    const namesConnection = provider === 'github' || provider === 'bitbucket';
    return {
      provider,
      installed: connected,
      accountLabel: status?.installation?.[ACCOUNT_FIELD[provider]] ?? null,
      disconnectIntegrationId,
      canDisconnectNatively: !namesConnection || disconnectIntegrationId !== null,
      webManaged: provider === 'github' && !actionPending && githubConnection === null,
      actionPending,
    };
  });
}
