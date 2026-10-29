import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import {
  environmentMembers,
  type EnvironmentMemberResponse,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';

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
