import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';

/** Compact "3 vars · 2 cmds" summary, or an empty string when the environment is empty. */
export function formatEnvironmentCounts(environment: EnvironmentSummary): string {
  const vars = environment.plainVarCount + environment.secretCount;
  return [
    vars > 0 && `${vars} vars`,
    environment.commandCount > 0 && `${environment.commandCount} cmds`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The owner's environment for a repository, matched the way the server stores
 * it: lowercased GitHub and GitLab paths, and the Bitbucket UUID pair.
 */
export function findRepositoryEnvironment(
  environments: readonly EnvironmentSummary[],
  repository: EnvironmentRepository
): EnvironmentSummary | undefined {
  if (repository.platform === 'bitbucket') {
    const workspaceUuid = repository.workspaceUuid.toLowerCase();
    const repositoryUuid = repository.repositoryUuid.toLowerCase();
    return environments.find(
      environment =>
        environment.platform === 'bitbucket' &&
        environment.bitbucketWorkspaceUuid === workspaceUuid &&
        environment.bitbucketRepositoryUuid === repositoryUuid
    );
  }
  const fullName = (
    repository.platform === 'gitlab' ? repository.projectPath : repository.fullName
  ).toLowerCase();
  return environments.find(
    environment =>
      environment.platform === repository.platform && environment.repoFullName === fullName
  );
}
