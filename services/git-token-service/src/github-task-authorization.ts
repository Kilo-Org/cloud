import type { GitHubTaskDecision, GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import type { WorkspaceGitHubRepositoryAccess } from '@kilocode/worker-utils/workspace-repository-access';
import type { GetCloudAgentAuthForRepoSuccess } from './index.js';
import type { GitHubTokenService } from './github-token-service.js';
import { GitHubTaskResources } from './github-task-resources.js';

type ResourceEnv = ConstructorParameters<typeof GitHubTaskResources>[1];

export async function authorizeGitHubTaskCredential(
  env: ResourceEnv,
  tokens: Pick<GitHubTokenService, 'getTokenForRepositoryIds'>,
  auth: GetCloudAgentAuthForRepoSuccess,
  grant: GitHubTaskGrant,
  decision: Extract<GitHubTaskDecision, { allowed: true }>,
  requestUrl: string,
  approved: readonly WorkspaceGitHubRepositoryAccess[] = []
): Promise<string | null> {
  const requestedNames = new Set(
    decision.checks.flatMap(check =>
      check.kind === 'repository-read' ? [`${check.owner}/${check.name}`] : []
    )
  );
  requestedNames.add(`${grant.repository.owner}/${grant.repository.name}`);
  const sameIdentityRepositories = approved.filter(
    repo =>
      requestedNames.has(`${repo.owner}/${repo.name}`) &&
      repo.owner === grant.repository.owner &&
      repo.identity.source === auth.source &&
      repo.identity.appType === auth.appType &&
      (auth.source !== 'installation' || repo.identity.providerSubjectId === auth.installationId)
  );
  const lookupToken =
    auth.source === 'installation' && sameIdentityRepositories.length > 1
      ? await tokens.getTokenForRepositoryIds(
          auth.installationId,
          sameIdentityRepositories.map(repo => repo.repositoryId),
          auth.appType,
          'read'
        )
      : auth.githubToken;
  const resources = new GitHubTaskResources(lookupToken, env);
  const scope = await resources.verify(grant, decision.checks, approved);
  if (
    decision.operation === 'read' &&
    new URL(requestUrl).pathname !== '/graphql' &&
    decision.checks.some(
      check =>
        check.kind === 'repository-read' &&
        !approved.some(repo => repo.owner === check.owner && repo.name === check.name)
    )
  )
    return null;
  const mode = decision.operation === 'read' ? 'read' : 'contribute';
  if (auth.source === 'user') return resources.scopeUserToken(scope, mode);
  if (!scope.repositoryIds) throw new Error('Repository scope unavailable');
  return tokens.getTokenForRepositoryIds(
    auth.installationId,
    scope.repositoryIds,
    auth.appType,
    mode
  );
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
