import { resolveGitHubIntegrationIdForRepository } from '@/lib/cloud-agent/github-integration-resolution';
import { PLATFORM } from '@/lib/integrations/core/constants';

export async function resolveGitHubPrepareParams(input: {
  userId: string;
  organizationId?: string;
  githubRepo: string | undefined;
  githubIntegrationId?: string;
}): Promise<{ githubRepo: string | undefined; githubIntegrationId?: string; platform: 'github' }> {
  // Pin the integration that owns the repository, so the runtime's repository
  // preflight checks that exact integration. An explicitly supplied id wins.
  // An unresolvable repository stays unpinned, and the preflight then checks it
  // across the caller's connections.
  const resolvedIntegrationId =
    input.githubIntegrationId ??
    (input.githubRepo === undefined
      ? null
      : await resolveGitHubIntegrationIdForRepository(
          input.organizationId === undefined
            ? { type: 'user', id: input.userId }
            : { type: 'org', id: input.organizationId },
          input.githubRepo
        ));

  return {
    githubRepo: input.githubRepo,
    githubIntegrationId: resolvedIntegrationId ?? undefined,
    platform: PLATFORM.GITHUB,
  };
}
