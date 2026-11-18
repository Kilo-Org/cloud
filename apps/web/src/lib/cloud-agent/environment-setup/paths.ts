import { repositoryLeaf, type EnvironmentRepositoryEntry } from '@kilocode/cloud-agent-profile';

export function setupRepositoryPaths(
  repositories: readonly EnvironmentRepositoryEntry[]
): string[] {
  return repositories.map(repository => `/workspace/${repositoryLeaf(repository.repoFullName)}`);
}

export function setupWorkingDirectory(repositories: readonly EnvironmentRepositoryEntry[]): string {
  const paths = setupRepositoryPaths(repositories);
  return paths.length > 1 ? '/workspace' : (paths[0] ?? '/workspace');
}
