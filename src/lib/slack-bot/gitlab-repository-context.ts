import type { Owner, PlatformRepository } from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';

export type GitLabRepositoryContext = {
  accountLogin: string | null;
  repositoryAccess: string | null;
  repositoriesSyncedAt: string | null;
  repositories: PlatformRepository[] | null;
  instanceUrl: string | null;
};

/**
 * Get GitLab repository context for an owner from their GitLab integration.
 * This does not perform extra API requests; it uses data stored on the integration row.
 */
export async function getGitLabRepositoryContext(owner: Owner): Promise<GitLabRepositoryContext> {
  const integration = await getIntegrationForOwner(owner, PLATFORM.GITLAB);
  if (!integration) {
    return {
      accountLogin: null,
      repositoryAccess: null,
      repositoriesSyncedAt: null,
      repositories: null,
      instanceUrl: null,
    };
  }

  const repositories = integration.repositories ? integration.repositories : null;
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

  return {
    accountLogin: integration.platform_account_login,
    repositoryAccess: integration.repository_access,
    repositoriesSyncedAt: integration.repositories_synced_at,
    repositories,
    instanceUrl,
  };
}

/** Redact self-hosted GitLab URLs so internal hostnames don't leak into LLM prompts. */
function describeInstance(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'gitlab.com') return 'gitlab.com';
  } catch {
    // malformed URL — fall through
  }
  return 'self-hosted GitLab';
}

export function formatGitLabRepositoriesForPrompt(context: GitLabRepositoryContext): string {
  const headerLines: string[] = ['\n\nGitLab repository context for this workspace:'];

  if (context.accountLogin) {
    headerLines.push(`- Account: ${context.accountLogin}`);
  }
  if (context.instanceUrl) {
    headerLines.push(`- Instance: ${describeInstance(context.instanceUrl)}`);
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

When the user asks you to work on a GitLab project, ask them to specify the project path explicitly in group/project format.`;
    }

    return `${header}
- No GitLab repositories are currently connected. The user will need to specify a project manually.`;
  }

  const repoList = context.repositories
    .map(repo => `- ${repo.full_name}${repo.private ? ' (private)' : ''} [id: ${repo.id}]`)
    .join('\n');

  return `${header}

Available GitLab projects:
${repoList}

When the user asks you to work on code without specifying a project, try to infer the correct project from context or ask them to clarify which project they want to use. GitLab project paths may have nested groups (e.g., group/subgroup/project).`;
}
