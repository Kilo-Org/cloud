import { parseGitUrl } from '@kilocode/worker-utils/git-url';

export type RepositoryIntegrationResolution =
  | { success: true; platformIntegrationId?: string }
  | { success: false; reason: GetTokenForRepoFailure['reason'] | 'service_unavailable' };

export function extractGitHubRepo(gitUrl: string): string | undefined {
  const coordinates = parseGitUrl(gitUrl);
  if (coordinates?.platform !== 'github') return undefined;
  return `${coordinates.owner}/${coordinates.repo}`;
}

export async function resolveRepositoryIntegration(
  env: Env,
  input: {
    gitUrl: string;
    userId: string;
    orgId?: string;
    expectedIntegrationId?: string;
  }
): Promise<RepositoryIntegrationResolution> {
  const githubRepo = extractGitHubRepo(input.gitUrl);
  if (!githubRepo) return { success: true };
  if (!env.GIT_TOKEN_SERVICE) return { success: false, reason: 'service_unavailable' };

  const result = await env.GIT_TOKEN_SERVICE.getTokenForRepo({
    githubRepo,
    userId: input.userId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.expectedIntegrationId ? { expectedIntegrationId: input.expectedIntegrationId } : {}),
  });
  if (!result.success) return result;
  return { success: true, platformIntegrationId: result.platformIntegrationId };
}
