import type { Owner, PlatformRepository } from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';

export type GitHubRepositoryContext = {
  accountLogin: string | null;
  repositoryAccess: string | null;
  repositoriesSyncedAt: string | null;
  repositories: PlatformRepository[] | null;
};

/**
 * Get GitHub repository context for an owner from their GitHub integration.
 * This does not perform extra API requests; it uses data stored on the integration row.
 */
export async function getGitHubRepositoryContext(owner: Owner): Promise<GitHubRepositoryContext> {
  const integration = await getIntegrationForOwner(owner, PLATFORM.GITHUB);
  if (!integration) {
    return {
      accountLogin: null,
      repositoryAccess: null,
      repositoriesSyncedAt: null,
      repositories: null,
    };
  }

  const repositories = integration.repositories ? integration.repositories : null;

  return {
    accountLogin: integration.platform_account_login,
    repositoryAccess: integration.repository_access,
    repositoriesSyncedAt: integration.repositories_synced_at,
    repositories,
  };
}

export function formatGitHubRepositoriesForPrompt(context: GitHubRepositoryContext): string {
  const headerLines: string[] = ['\n\nGitHub repository context for this workspace:'];

  if (context.accountLogin) {
    headerLines.push(`- Installation account: ${context.accountLogin}`);
  }
  if (context.repositoryAccess) {
    headerLines.push(`- Repository access: ${context.repositoryAccess}`);
  }
  if (context.repositoriesSyncedAt) {
    headerLines.push(`- Repositories synced at: ${context.repositoriesSyncedAt}`);
  }

  const header = headerLines.join('\n');

  if (!context.repositories || context.repositories.length === 0) {
    if (context.repositoryAccess === 'all') {
      return `${header}
- Repository list: not stored for "all" access (no repo list to show without extra requests).

When the user asks you to work on code, ask them to specify the repository explicitly in owner/repo format.`;
    }

    return `${header}
- No GitHub repositories are currently connected. The user will need to specify a repository manually.`;
  }

  const repoList = context.repositories
    .map(repo => `- ${repo.full_name}${repo.private ? ' (private)' : ''} [id: ${repo.id}]`)
    .join('\n');

  return `${header}

Available repositories:
${repoList}

When the user asks you to work on code without specifying a repository, try to infer the correct repository from context or ask them to clarify which repository they want to use.`;
}
