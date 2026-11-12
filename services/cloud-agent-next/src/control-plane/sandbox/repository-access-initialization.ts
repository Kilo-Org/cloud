import type { ControlPlaneCredentialSource } from '../../shared/control-plane-protocol.js';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import {
  githubUserAuthorizationAllowed,
  memberGitHubAccess,
} from '../../session/environment-launch.js';
import type { WorkspaceRepositoryAccess } from '@kilocode/worker-utils/workspace-repository-access';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import { grantScmEntries } from '../../sandbox-control/session-credential-members.js';
import type { GitTokenService } from '../../types.js';

/** Only persisted server grants seed authority. Environment edits and guest files cannot enter here. */
export async function repositoryAccessFromTrustedGrant(
  grant: SessionCredentialGrant,
  tokens: GitTokenService
): Promise<WorkspaceRepositoryAccess> {
  const entries = grantScmEntries(grant).filter(entry => entry.repository.type === 'github');
  if (entries.length && !tokens.prepareWorkspaceRepositoryAccess)
    throw new Error('Repository authorization unavailable');
  const repositories: WorkspaceRepositoryAccess['repositories'] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 4).map(async entry => {
        if (entry.repository.type !== 'github') throw new Error('Repository identity mismatch');
        const result = await tokens.prepareWorkspaceRepositoryAccess?.({
          userId: grant.userId,
          orgId: grant.orgId,
          githubRepo: entry.repository.repo,
          mode: 'contribute',
          source: 'environment',
          expectedIntegrationId: entry.repository.expectedIntegrationId,
          expectedSource: entry.scm.githubAuthSource,
          accessPurpose: entry.repository.accessPurpose,
          persistedCapability: entry.scm.capability?.credential,
          repositoryId: entry.scm.githubTaskGrant?.repository.id,
        });
        if (!result?.success) throw new Error('Repository authorization unavailable');
        return result.repository;
      })
    );
    repositories.push(...batch);
  }
  return {
    version: 1,
    scopeId: grant.scopeId,
    revision: 0,
    repositories: [...new Map(repositories.map(repo => [repo.repositoryId, repo])).values()],
  };
}

/** New scopes seed from the server-admitted launch and environment, before capability issuance. */
export async function repositoryAccessFromAdmittedSource(
  source: ControlPlaneCredentialSource,
  environment: SessionEnvironmentReference | null,
  tokens: GitTokenService,
  scopeId: string
): Promise<WorkspaceRepositoryAccess> {
  const repositories = [
    ...(source.repository?.type === 'github' ? [source.repository.repo] : []),
    ...(environment && 'repositories' in environment
      ? (environment.repositories ?? []).flatMap(repo =>
          repo.identity.platform === 'github' ? [repo.repoFullName] : []
        )
      : []),
  ];
  if (!repositories.length || !tokens.prepareWorkspaceRepositoryAccess)
    throw new Error('Repository authorization unavailable');
  const selected: WorkspaceRepositoryAccess['repositories'] = [];
  const unique = [...new Set(repositories.map(name => name.toLowerCase()))];
  for (let offset = 0; offset < unique.length; offset += 4) {
    const batch = await Promise.all(
      unique.slice(offset, offset + 4).map(async githubRepo => {
        const launch =
          source.repository?.type === 'github' &&
          source.repository.repo.toLowerCase() === githubRepo
            ? source.repository
            : undefined;
        const userAllowed = githubUserAuthorizationAllowed({
          allowUserAuthorization: launch?.allowUserAuthorization,
          createdOnPlatform: source.createdOnPlatform,
        });
        const result = await tokens.prepareWorkspaceRepositoryAccess?.({
          userId: source.userId,
          orgId: source.orgId,
          githubRepo,
          mode: 'contribute',
          source: 'environment',
          expectedSource: userAllowed ? undefined : 'installation',
          accessPurpose:
            launch?.githubAccessPurpose ??
            memberGitHubAccess(source.repository).githubAccessPurpose ??
            'workflow',
          expectedIntegrationId:
            source.repository?.type === 'github' &&
            source.repository.repo.toLowerCase() === githubRepo
              ? source.repository.githubIntegrationId
              : undefined,
        });
        if (!result?.success) throw new Error('Repository authorization unavailable');
        return result.repository;
      })
    );
    selected.push(...batch);
  }
  return { version: 1, scopeId, revision: 0, repositories: selected };
}
