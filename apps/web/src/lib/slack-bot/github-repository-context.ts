import {
  requireNumericPlatformRepositories,
  type Owner,
  type PlatformRepository,
} from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';

export type GitHubRepositoryContext = {
  repositories: GitHubRepositoryChoice[] | null;
};

export type GitHubRepositoryChoice = PlatformRepository & {
  githubIntegrationId: string;
  githubAppType: 'standard' | 'lite';
};

export async function getGitHubRepositoryContext(owner: Owner): Promise<GitHubRepositoryContext> {
  const integrations = await getAllIntegrationsForOwner(owner);
  const repositories = integrations.flatMap(integration => {
    if (
      integration.platform !== PLATFORM.GITHUB ||
      integration.integration_status !== 'active' ||
      !isPlatformIntegrationHealthy(integration)
    ) {
      return [];
    }

    return (requireNumericPlatformRepositories(integration.repositories) ?? []).map(repository => ({
      ...repository,
      githubIntegrationId: integration.id,
      githubAppType: integration.github_app_type ?? 'standard',
    }));
  });

  return { repositories: repositories.length > 0 ? repositories : null };
}

export async function resolveGitHubRepositoryForOwner(
  owner: Owner,
  fullName: string
): Promise<GitHubRepositoryChoice | null> {
  const context = await getGitHubRepositoryContext(owner);
  const matches =
    context.repositories?.filter(repository => repository.full_name === fullName) ?? [];

  return matches.length === 1 ? matches[0] : null;
}

export function formatGitHubRepositoriesForPrompt(context: GitHubRepositoryContext): string {
  const header = '\n\nGitHub repository context for this workspace:';

  if (!context.repositories || context.repositories.length === 0) {
    return `${header}
- No GitHub repositories are currently available for this Kilo organization.`;
  }

  const repoList = context.repositories
    .map(
      repo =>
        `- ${repo.full_name}${repo.private ? ' (private)' : ''} [id: ${repo.id}; association: ${repo.githubIntegrationId}; app: ${repo.githubAppType}]`
    )
    .join('\n');

  return `${header}

Available repositories:
${repoList}

When the user asks you to work on code without specifying a repository, try to infer the correct repository from context or ask them to clarify which repository they want to use.`;
}
