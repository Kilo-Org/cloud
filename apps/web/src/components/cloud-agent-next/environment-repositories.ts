import type {
  EnvironmentIdentityResponse,
  EnvironmentRepositoryEntry,
} from '@kilocode/cloud-agent-profile';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { parseGitLabProjectPath } from './cloud-session-fork';

export function repositoryName(repository: EnvironmentRepository): string {
  return repository.platform === 'gitlab' ? repository.projectPath : repository.fullName;
}

/** Identity of a repository as the server compares it: the UUID pair for Bitbucket, else the path. */
export function repositoryKey(repository: EnvironmentRepository): string {
  return repository.platform === 'bitbucket'
    ? `bitbucket:${repository.workspaceUuid.toLowerCase()}:${repository.repositoryUuid.toLowerCase()}`
    : `${repository.platform}:${repositoryName(repository).toLowerCase()}`;
}

function gitlabProjectPath(repoFullName: string, cloneUrl: string | null | undefined): string {
  const projectPath = parseGitLabProjectPath(cloneUrl ?? '')
    ?.split('/')
    .slice(-repoFullName.split('/').length)
    .join('/');
  return projectPath?.toLowerCase() === repoFullName.toLowerCase() ? projectPath : repoFullName;
}

/** A stored V2 repository as the create and update inputs take it. */
export function entryToRepository(entry: EnvironmentRepositoryEntry): EnvironmentRepository {
  switch (entry.platform) {
    case 'github':
      return { platform: 'github', fullName: entry.repoFullName };
    case 'gitlab':
      return {
        platform: 'gitlab',
        projectPath: gitlabProjectPath(entry.repoFullName, entry.gitlabCloneUrl),
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        fullName: entry.repoFullName,
        workspaceUuid: entry.bitbucketWorkspaceUuid,
        repositoryUuid: entry.bitbucketRepositoryUuid,
      };
  }
}

/** Normalize saved environments to the repository list used by the editor. */
export function repositoriesForEnvironment(
  environment: EnvironmentIdentityResponse
): EnvironmentRepository[] {
  if (environment.repositories !== undefined) {
    return environment.repositories.map(entryToRepository);
  }
  switch (environment.platform) {
    case 'github':
      return [{ platform: 'github', fullName: environment.repoFullName }];
    case 'gitlab':
      return [
        {
          platform: 'gitlab',
          projectPath: gitlabProjectPath(environment.repoFullName, environment.gitlabCloneUrl),
        },
      ];
    case 'bitbucket':
      if (!environment.bitbucketWorkspaceUuid || !environment.bitbucketRepositoryUuid) {
        throw new Error('Environment Bitbucket repository identity is incomplete');
      }
      return [
        {
          platform: 'bitbucket',
          fullName: environment.repoFullName,
          workspaceUuid: environment.bitbucketWorkspaceUuid,
          repositoryUuid: environment.bitbucketRepositoryUuid,
        },
      ];
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
