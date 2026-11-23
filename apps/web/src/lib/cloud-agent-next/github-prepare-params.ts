import { resolveGitHubIntegrationIdForRepository } from '@/lib/cloud-agent/github-integration-resolution';
import { PLATFORM } from '@/lib/integrations/core/constants';

export async function resolveGitHubPrepareParams(input: {
  userId: string;
  organizationId?: string;
  githubRepo: string | undefined;
  githubIntegrationId?: string;
}): Promise<{ githubRepo: string | undefined; githubIntegrationId?: string; platform: 'github' }> {
  // The runtime's repository preflight runs only when the request names the
  // integration that owns the repository, so resolve it for the caller here.
  // An explicitly supplied id wins, and an unresolvable repository stays
  // unqualified (the previous behaviour) rather than refusing a request the
  // runtime can still serve.
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
