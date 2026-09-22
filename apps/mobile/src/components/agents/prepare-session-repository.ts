// The repository half of a Cloud Agent `prepareSession` body, used by the
// shared `prepareAgentSession` core that both the ordinary create path
// (`useNewSessionCreator`) and the clone path (`useContinueCloudCreate`) run.
// Each path maps one selected repository row onto exactly one provider field,
// so the provider rules live here once and the two paths cannot diverge.
import {
  type NewSessionRepository,
  type RepositoryPlatform,
} from '@/components/agents/new-session-repository-state';

/**
 * The repository fields a `prepareSession` body carries. Exactly one is set by
 * `setRepositoryField`, matching the selected row's platform; a picker key
 * (`platform:fullName`) must never reach `githubRepo`.
 */
export type PrepareSessionRepositoryFields = {
  githubRepo?: string;
  gitlabProject?: string;
  bitbucketRepo?: { fullName: string; workspaceUuid: string; repositoryUuid: string };
};

/**
 * The retry fingerprint's repository identity. Includes the platform so two
 * same-named repos on different providers mint distinct retry keys, and the
 * Bitbucket workspace/repository uuids so a workspace rename cannot collide.
 */
export function resolveRepoFingerprint(repository: NewSessionRepository | null): {
  platform: RepositoryPlatform;
  fullName: string;
  workspaceUuid?: string | null;
  repositoryUuid?: string | null;
} | null {
  if (!repository) {
    return null;
  }
  if (repository.platform === 'bitbucket') {
    return {
      platform: repository.platform,
      fullName: repository.fullName,
      workspaceUuid: repository.workspaceUuid ?? null,
      repositoryUuid: repository.repositoryUuid ?? null,
    };
  }
  return { platform: repository.platform, fullName: repository.fullName };
}

/**
 * Write exactly one repository field into a prepare body, matching the selected
 * row's platform, and report whether a field was written. Bitbucket requires
 * workspace + repository uuids, so it contributes nothing when those are
 * missing (which cannot happen for a row that came from
 * `listBitbucketRepositories`) — the caller uses the `false` result to skip the
 * branch that only makes sense alongside a repository.
 */
export function setRepositoryField(
  input: PrepareSessionRepositoryFields,
  repository: NewSessionRepository | null
): boolean {
  if (!repository) {
    return false;
  }
  if (repository.platform === 'github') {
    input.githubRepo = repository.fullName;
    return true;
  }
  if (repository.platform === 'gitlab') {
    input.gitlabProject = repository.fullName;
    return true;
  }
  if (repository.workspaceUuid && repository.repositoryUuid) {
    input.bitbucketRepo = {
      fullName: repository.fullName,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
    };
    return true;
  }
  return false;
}
