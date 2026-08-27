import {
  requireNumericPlatformRepositories,
  type Owner,
  type PlatformRepository,
} from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
} from '@/lib/integrations/db/platform-integrations';

export type GitHubInstallationRepositoryContext = {
  platformIntegrationId: string;
  accountLogin: string | null;
  repositoryAccess: string | null;
  repositoriesSyncedAt: string | null;
  repositories: PlatformRepository[] | null;
};

export type GitHubRepositoryContext = {
  installations: GitHubInstallationRepositoryContext[];
};

type GitHubRepositoryContextLoaders = {
  getIntegrationForOwner: typeof getIntegrationForOwner;
  getIntegrationsByOrganization: typeof getIntegrationsByOrganization;
};

function toInstallationContext(
  integration: Awaited<ReturnType<typeof getIntegrationForOwner>>
): GitHubInstallationRepositoryContext | null {
  if (!integration) return null;

  return {
    platformIntegrationId: integration.id,
    accountLogin: integration.platform_account_login,
    repositoryAccess: integration.repository_access,
    repositoriesSyncedAt: integration.repositories_synced_at,
    repositories: requireNumericPlatformRepositories(integration.repositories),
  };
}

/**
 * Get GitHub repository context for an owner from their GitHub integrations.
 * This does not perform extra API requests; it uses data stored on the integration row.
 */
export async function getGitHubRepositoryContext(
  owner: Owner,
  loaders: GitHubRepositoryContextLoaders = {
    getIntegrationForOwner,
    getIntegrationsByOrganization,
  }
): Promise<GitHubRepositoryContext> {
  const integrations =
    owner.type === 'org'
      ? (await loaders.getIntegrationsByOrganization(owner.id, PLATFORM.GITHUB)).filter(
          isPlatformIntegrationHealthy
        )
      : [await loaders.getIntegrationForOwner(owner, PLATFORM.GITHUB)];

  return {
    installations: integrations
      .map(toInstallationContext)
      .filter((integration): integration is GitHubInstallationRepositoryContext => !!integration),
  };
}

export function formatGitHubRepositoriesForPrompt(context: GitHubRepositoryContext): string {
  const header = '\n\nGitHub repository context for this workspace:';
  if (context.installations.length === 0) {
    return `${header}\n- No GitHub installations are connected.`;
  }

  const installations = context.installations.map(installation => {
    const account = installation.accountLogin ?? 'unknown';
    const lines = [
      `Installation account: ${account}`,
      `- platformIntegrationId: ${installation.platformIntegrationId}`,
    ];
    if (installation.repositoryAccess) {
      lines.push(`- Repository access: ${installation.repositoryAccess}`);
    }
    if (installation.repositoriesSyncedAt) {
      lines.push(`- Repositories synced at: ${installation.repositoriesSyncedAt}`);
    }

    if (!installation.repositories?.length) {
      lines.push(
        installation.repositoryAccess === 'all'
          ? '- Repository list: not stored for "all" access. Ask for the repository in owner/repo format.'
          : '- No repositories are currently connected through this installation.'
      );
      return lines.join('\n');
    }

    lines.push(
      '- Available repositories:',
      ...installation.repositories.map(
        repository =>
          `  - ${repository.full_name}${repository.private ? ' (private)' : ''} [repositoryId: ${repository.id}; account: ${account}; platformIntegrationId: ${installation.platformIntegrationId}]`
      )
    );
    return lines.join('\n');
  });

  return `${header}

${installations.join('\n\n')}

Use this context to choose a repository, not to authorize access. Submit owner/repo and let Cloud Agent resolve and authorize it. Only include githubIntegrationId when preserving an explicit choice between duplicate repository entries. If no repository is specified, infer an unambiguous listed repository or ask for clarification.`;
}
