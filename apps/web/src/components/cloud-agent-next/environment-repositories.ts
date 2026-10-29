import type { EnvironmentRepositoryEntry } from '@kilocode/cloud-agent-profile';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';

export function repositoryName(repository: EnvironmentRepository): string {
  return repository.platform === 'gitlab' ? repository.projectPath : repository.fullName;
}

/** Identity of a repository as the server compares it: the UUID pair for Bitbucket, else the path. */
export function repositoryKey(repository: EnvironmentRepository): string {
  return repository.platform === 'bitbucket'
    ? `bitbucket:${repository.workspaceUuid.toLowerCase()}:${repository.repositoryUuid.toLowerCase()}`
    : `${repository.platform}:${repositoryName(repository).toLowerCase()}`;
}

/** A stored V2 repository as the create and update inputs take it. */
export function entryToRepository(entry: EnvironmentRepositoryEntry): EnvironmentRepository {
  switch (entry.platform) {
    case 'github':
      return { platform: 'github', fullName: entry.repoFullName };
    case 'gitlab':
      return { platform: 'gitlab', projectPath: entry.repoFullName };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        fullName: entry.repoFullName,
        workspaceUuid: entry.bitbucketWorkspaceUuid,
        repositoryUuid: entry.bitbucketRepositoryUuid,
      };
  }
}

/** Adds a repository at the end. A repository already in the list stays where it is. */
export function addRepository(
  repositories: readonly EnvironmentRepository[],
  repository: EnvironmentRepository
): EnvironmentRepository[] {
  const key = repositoryKey(repository);
  return repositories.some(existing => repositoryKey(existing) === key)
    ? [...repositories]
    : [...repositories, repository];
}

export function removeRepository(
  repositories: readonly EnvironmentRepository[],
  repository: EnvironmentRepository
): EnvironmentRepository[] {
  const key = repositoryKey(repository);
  return repositories.filter(existing => repositoryKey(existing) !== key);
}

export function sameRepositories(
  left: readonly EnvironmentRepository[],
  right: readonly EnvironmentRepository[]
): boolean {
  return (
    left.length === right.length &&
    left.every((repository, index) => {
      const other = right[index];
      return other !== undefined && repositoryKey(repository) === repositoryKey(other);
    })
  );
}
