import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import {
  environmentMembers,
  type EnvironmentMemberResponse,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';

/** Whether one environment member is the repository, matched as the server stores it. */
export function memberMatchesRepository(
  member: EnvironmentMemberResponse,
  repository: EnvironmentRepository
): boolean {
  if (repository.platform === 'bitbucket') {
    return (
      member.platform === 'bitbucket' &&
      member.bitbucketWorkspaceUuid?.toLowerCase() === repository.workspaceUuid.toLowerCase() &&
      member.bitbucketRepositoryUuid?.toLowerCase() === repository.repositoryUuid.toLowerCase()
    );
  }
  const fullName = (
    repository.platform === 'gitlab' ? repository.projectPath : repository.fullName
  ).toLowerCase();
  return member.platform === repository.platform && member.repoFullName.toLowerCase() === fullName;
}

/** Every environment of the owner that contains the repository. */
export function findRepositoryEnvironments(
  environments: readonly EnvironmentSummary[],
  repository: EnvironmentRepository
): EnvironmentSummary[] {
  return environments.filter(environment =>
    environmentMembers(environment).some(member => memberMatchesRepository(member, repository))
  );
}
