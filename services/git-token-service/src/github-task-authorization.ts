import type { GitHubTaskDecision, GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import type { GetCloudAgentAuthForRepoSuccess } from './index.js';
import type { GitHubTokenService } from './github-token-service.js';
import { GitHubTaskResources } from './github-task-resources.js';

type ResourceEnv = ConstructorParameters<typeof GitHubTaskResources>[1];

export async function authorizeGitHubTaskCredential(
  env: ResourceEnv,
  tokens: Pick<GitHubTokenService, 'getToken' | 'getTokenForRepositoryIds'>,
  auth: GetCloudAgentAuthForRepoSuccess,
  grant: GitHubTaskGrant,
  decision: Extract<GitHubTaskDecision, { allowed: true }>,
  requestUrl: string
): Promise<string | null> {
  const ownerRead =
    decision.operation === 'read' &&
    decision.checks.some(
      check =>
        check.kind === 'owner-read' ||
        (check.kind === 'repository-read' && check.owner === grant.repository.owner)
    );
  // Only trusted lookups may use an installation-wide token. The guest never receives it.
  const lookupToken =
    auth.source === 'installation' && ownerRead
      ? await tokens.getToken(auth.installationId, auth.appType)
      : auth.githubToken;
  const resources = new GitHubTaskResources(lookupToken, env);
  const scope = await resources.verify(grant, decision.checks);
  if (
    decision.operation === 'read' &&
    new URL(requestUrl).pathname !== '/graphql' &&
    decision.checks.some(
      check => check.kind === 'repository-read' && check.owner !== grant.repository.owner
    )
  ) {
    return null;
  }
  if (auth.source === 'user') return resources.scopeUserToken(scope);
  if (scope.repositoryIds === undefined) return lookupToken;
  if (scope.repositoryIds.length === 1) return auth.githubToken;
  return tokens.getTokenForRepositoryIds(auth.installationId, scope.repositoryIds, auth.appType);
}

/** Direct runtimes also receive a repository-scoped identity credential, never the parent token. */
export async function scopeNativeGitHubCredential(
  env: ResourceEnv,
  auth: GetCloudAgentAuthForRepoSuccess,
  repository: { owner: string; repo: string }
): Promise<GetCloudAgentAuthForRepoSuccess> {
  if (auth.source === 'installation') return auth;
  const resources = new GitHubTaskResources(auth.githubToken, env);
  const resolved = await resources.repository(repository.owner, repository.repo);
  const githubToken = await resources.scopeUserToken({
    owner: repository.owner,
    repositoryIds: [resolved.id],
  });
  return { ...auth, githubToken };
}
