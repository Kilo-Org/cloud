import { type Owner, type PlatformRepository } from '@/lib/integrations/core/types';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { PlatformRepositoryCacheSchema } from '@/lib/integrations/core/schemas';
import { captureException } from '@sentry/nextjs';

export type GitHubRepositoryContext = {
  repositories: GitHubRepositoryChoice[] | null;
};

export type GitHubRepositoryChoice = PlatformRepository & {
  githubIntegrationId: string;
  githubAppType: 'standard' | 'lite';
};

export async function getGitHubRepositoryContext(
  owner: Owner,
  purpose: 'workflow' | 'agent' = 'workflow'
): Promise<GitHubRepositoryContext> {
  const integrations = await getAllIntegrationsForOwner(owner);
  const repositories = integrations.flatMap(integration => {
    if (
      integration.platform !== PLATFORM.GITHUB ||
      (integration.github_connection_role !== 'workflow' &&
        !(purpose === 'agent' && integration.github_connection_role === 'agent_only')) ||
      integration.integration_status !== 'active' ||
      !isPlatformIntegrationHealthy(integration)
    ) {
      return [];
    }

    const parsedRepositories = PlatformRepositoryCacheSchema.safeParse(
      integration.repositories ?? null
    );
    if (!parsedRepositories.success) {
      captureException(new Error('Invalid cached GitHub repository inventory'), {
        tags: { component: 'slack-bot', op: 'parse-github-repository-cache' },
        extra: { integrationId: integration.id },
      });
      return [];
    }

    return (parsedRepositories.data ?? []).map(repository => ({
      ...repository,
      githubIntegrationId: integration.id,
      githubAppType: integration.github_app_type ?? 'standard',
    }));
  });

  return { repositories: repositories.length > 0 ? repositories : null };
}

export async function resolveGitHubRepositoryForOwner(
  owner: Owner,
  fullName: string,
  purpose: 'workflow' | 'agent' = 'workflow'
): Promise<GitHubRepositoryChoice | null> {
  const context = await getGitHubRepositoryContext(owner, purpose);
  const normalizedFullName = fullName.toLowerCase();
  const matches =
    context.repositories?.filter(
      repository => repository.full_name.toLowerCase() === normalizedFullName
    ) ?? [];

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
