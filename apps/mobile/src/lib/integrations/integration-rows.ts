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
   * The GitHub connection a native disconnect targets. Null when the hub cannot
   * name exactly one connection, and the web page has to own the change.
   */
  githubIntegrationId: string | null;
  /**
   * The platform's connections can only be changed on the web: Bitbucket's
   * controls live there, and several GitHub installations are ambiguous in a
   * single row.
   */
  webManaged: boolean;
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
 * web hub uses, plus the GitHub connections that read cannot name an id for.
 */
export function buildIntegrationRows(input: {
  scope: IntegrationScope;
  statuses: readonly IntegrationSetupStatus[];
  githubConnections: readonly IntegrationGitHubConnection[];
}): IntegrationRow[] {
  const statusByPlatform = new Map(input.statuses.map(status => [status.platform, status]));
  const installed: Partial<Record<IntegrationProvider, boolean>> = {};
  for (const provider of INTEGRATION_PROVIDERS) {
    installed[provider] = statusByPlatform.get(provider)?.installed === true;
  }

  const activeGitHub = input.githubConnections.filter(isActiveGitHubConnection);
  const githubIntegrationId = activeGitHub.length === 1 ? (activeGitHub[0]?.id ?? null) : null;

  return visibleIntegrationProviders(input.scope, installed).map(provider => {
    const status = statusByPlatform.get(provider);
    return {
      provider,
      installed: status?.installed === true,
      accountLabel: status?.installation?.[ACCOUNT_FIELD[provider]] ?? null,
      githubIntegrationId: provider === 'github' ? githubIntegrationId : null,
      webManaged:
        provider === 'bitbucket' || (provider === 'github' && githubIntegrationId == null),
    };
  });
}
