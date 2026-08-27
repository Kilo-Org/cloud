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
  resolveOrganizationGitHubIntegrationForRepository,
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

export type GitHubRepositorySelectionInput = {
  githubRepo: string;
  githubAccount?: string;
  githubIntegrationId?: string;
};

export type GitHubRepositorySelection =
  | { success: true; githubAccount: string; githubIntegrationId: string }
  | { success: false; error: string };

type GitHubRepositoryContextLoaders = {
  getIntegrationForOwner: typeof getIntegrationForOwner;
  getIntegrationsByOrganization: typeof getIntegrationsByOrganization;
};

function toInstallationContext(
  integration: Awaited<ReturnType<typeof getIntegrationForOwner>>
): GitHubInstallationRepositoryContext | null {
  if (!integration || !isPlatformIntegrationHealthy(integration)) return null;

  return {
    platformIntegrationId: integration.id,
    accountLogin: integration.platform_account_login,
    repositoryAccess: integration.repository_access,
    repositoriesSyncedAt: integration.repositories_synced_at,
    repositories: requireNumericPlatformRepositories(integration.repositories),
  };
}

/**
 * Get GitHub repository context for an owner from their GitHub integration.
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
      ? await loaders.getIntegrationsByOrganization(owner.id, PLATFORM.GITHUB)
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
    return `${header}\n- No healthy GitHub installations are connected.`;
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
          ? '- Repository list: not stored for "all" access. A repository must be supplied in owner/repo format.'
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

For a GitHub tool call, preserve the selected repository's account and platformIntegrationId exactly in githubAccount and githubIntegrationId. If no repository is specified, infer an unambiguous listed repository or ask for clarification.`;
}

function repositoryIsListed(
  installation: GitHubInstallationRepositoryContext,
  repositoryFullName: string
): boolean {
  return Boolean(
    installation.repositories?.some(
      repository => repository.full_name.toLowerCase() === repositoryFullName.toLowerCase()
    )
  );
}

function matchesSuppliedIdentity(
  installation: GitHubInstallationRepositoryContext,
  input: GitHubRepositorySelectionInput
): boolean {
  return (
    (input.githubIntegrationId === undefined ||
      installation.platformIntegrationId === input.githubIntegrationId) &&
    (input.githubAccount === undefined ||
      installation.accountLogin?.toLowerCase() === input.githubAccount.toLowerCase())
  );
}

function selectedInstallationResult(
  installation: GitHubInstallationRepositoryContext
): GitHubRepositorySelection {
  if (!installation.accountLogin) {
    return { success: false, error: 'The selected GitHub installation has no account name.' };
  }
  return {
    success: true,
    githubAccount: installation.accountLogin,
    githubIntegrationId: installation.platformIntegrationId,
  };
}

/**
 * Validates the repository identity selected by a bot tool call. Stored repository
 * entries may select their exact installation; manually supplied organization
 * repositories are resolved without a pin first so overlapping installations fail closed.
 */
export async function resolveGitHubRepositorySelection(
  owner: Owner,
  input: GitHubRepositorySelectionInput,
  context: GitHubRepositoryContext,
  resolveOrganizationIntegration = resolveOrganizationGitHubIntegrationForRepository
): Promise<GitHubRepositorySelection> {
  if (!input.githubAccount || !input.githubIntegrationId) {
    return {
      success: false,
      error: 'Select a GitHub repository entry with both its account and platformIntegrationId.',
    };
  }

  const listedMatches = context.installations.filter(
    installation =>
      repositoryIsListed(installation, input.githubRepo) &&
      matchesSuppliedIdentity(installation, input)
  );

  if (listedMatches.length > 1) {
    return {
      success: false,
      error:
        'Multiple GitHub installations contain that repository. Select the account and platformIntegrationId shown in the repository list.',
    };
  }

  const listedMatch = listedMatches[0];
  if (owner.type === 'user') {
    if (listedMatch) return selectedInstallationResult(listedMatch);

    const manualMatches = context.installations.filter(
      installation =>
        installation.repositoryAccess === 'all' && matchesSuppliedIdentity(installation, input)
    );
    if (manualMatches.length !== 1) {
      return {
        success: false,
        error: 'That GitHub repository is not available to this workspace.',
      };
    }
    return selectedInstallationResult(manualMatches[0]);
  }

  const resolution = await resolveOrganizationIntegration({
    organizationId: owner.id,
    repositoryFullName: input.githubRepo,
    ...(listedMatch ? { expectedPlatformIntegrationId: listedMatch.platformIntegrationId } : {}),
  });
  if (!resolution.success) {
    return {
      success: false,
      error:
        resolution.reason === 'ambiguous_installation'
          ? 'Multiple GitHub installations can access that repository. Select a repository entry with its account and platformIntegrationId.'
          : 'That GitHub repository is not available to this workspace.',
    };
  }

  if (
    (input.githubIntegrationId && input.githubIntegrationId !== resolution.integration.id) ||
    (input.githubAccount &&
      input.githubAccount.toLowerCase() !==
        resolution.integration.platform_account_login?.toLowerCase())
  ) {
    return {
      success: false,
      error: 'The supplied GitHub account or platformIntegrationId does not match that repository.',
    };
  }

  const selected = toInstallationContext(resolution.integration);
  return selected
    ? selectedInstallationResult(selected)
    : { success: false, error: 'That GitHub installation is not healthy.' };
}
