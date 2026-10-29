import { TRPCError } from '@trpc/server';
import {
  bitbucketCloneUrl,
  sameRepositoryIdentity,
  type EnvironmentReferenceRepository,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import type { PersistenceEnv } from '../persistence/types.js';
import {
  isTemporaryManagedBitbucketTokenFailure,
  authorizeCloudAgentGitHubRepo,
  resolveManagedBitbucketToken,
  resolveManagedGitLabToken,
} from '../services/git-token-service-client.js';
import { isMultiRepositoryEnvironment } from '../environment-build/reference.js';
import { launchRepositoryIdentity, memberGitHubAccess } from './environment-launch.js';
import type { SessionRepositoryRequest } from './session-requests.js';

type AccessContext = { env: PersistenceEnv; userId: string; orgId?: string };

export async function assertRepositoryAccessBeforeSessionCreation(
  input: AccessContext & { repository: SessionRepositoryRequest }
): Promise<void> {
  if (input.repository.type === 'github' && input.repository.githubIntegrationId) {
    await assertGitHubAccess(input, {
      repo: input.repository.repo,
      expectedIntegrationId: input.repository.githubIntegrationId,
      accessPurpose: input.repository.githubAccessPurpose ?? 'workflow',
    });
    return;
  }

  if (input.repository.type !== 'bitbucket') return;
  await assertBitbucketAccess(input, input.repository);
}

async function assertGitHubAccess(
  input: AccessContext,
  repository: { repo: string; expectedIntegrationId?: string; accessPurpose: 'workflow' | 'agent' }
): Promise<void> {
  const result = await authorizeCloudAgentGitHubRepo(input.env, {
    githubRepo: repository.repo,
    userId: input.userId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(repository.expectedIntegrationId
      ? { expectedIntegrationId: repository.expectedIntegrationId }
      : {}),
    accessPurpose: repository.accessPurpose,
  });
  if (!result.success) {
    throw new TRPCError({
      code:
        result.error.reason === 'service_not_configured' || result.error.reason === 'rpc_error'
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST',
      message: `GitHub repository authorization failed (${result.error.reason})`,
    });
  }
}

async function assertBitbucketAccess(
  input: AccessContext,
  repository: {
    url: string;
    workspaceUuid: string;
    repositoryUuid: string;
    bitbucketIntegrationId?: string;
  }
): Promise<void> {
  if (!input.orgId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repositories require an organization',
    });
  }

  const result = await resolveManagedBitbucketToken(input.env, {
    userId: input.userId,
    orgId: input.orgId,
    ...(repository.bitbucketIntegrationId
      ? { expectedIntegrationId: repository.bitbucketIntegrationId }
      : {}),
    workspaceUuid: repository.workspaceUuid,
    repositoryUuid: repository.repositoryUuid,
    repositoryUrl: repository.url,
  });
  if (!result.success) {
    throw new TRPCError({
      code: isTemporaryManagedBitbucketTokenFailure(result.reason)
        ? 'SERVICE_UNAVAILABLE'
        : 'BAD_REQUEST',
      message: `Bitbucket repository authorization failed (${result.reason})`,
    });
  }
}

/**
 * GitLab access is checked per instance here: the managed token lookup proves an
 * integration covers the clone URL's instance. The project itself is checked when
 * the grant issues its capability.
 */
async function assertGitLabAccess(
  input: AccessContext & { createdOnPlatform?: string },
  cloneUrl: string
): Promise<void> {
  const result = await resolveManagedGitLabToken(input.env, {
    userId: input.userId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    repositoryUrl: cloneUrl,
    ...(input.createdOnPlatform ? { createdOnPlatform: input.createdOnPlatform } : {}),
  });
  if (!result.success) {
    throw new TRPCError({
      code:
        result.reason === 'service_not_configured' || result.reason === 'rpc_error'
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST',
      message: `GitLab repository authorization failed (${result.reason})`,
    });
  }
}

async function assertMemberAccess(
  input: AccessContext & { createdOnPlatform?: string },
  member: EnvironmentReferenceRepository,
  launch: SessionRepositoryRequest
): Promise<void> {
  const identity = member.identity;
  switch (identity.platform) {
    case 'github': {
      // The same access as the grant gives the member, and never a pin.
      const access = memberGitHubAccess(launch);
      return assertGitHubAccess(input, {
        repo: member.repoFullName,
        accessPurpose: access.githubAccessPurpose ?? 'workflow',
      });
    }
    case 'gitlab':
      return assertGitLabAccess(input, identity.cloneUrl);
    case 'bitbucket':
      return assertBitbucketAccess(input, {
        url: bitbucketCloneUrl(member.repoFullName),
        workspaceUuid: identity.workspaceUuid,
        repositoryUuid: identity.repositoryUuid,
      });
  }
}

/**
 * The repository the launch check above authorizes: a pinned GitHub repository
 * and a Bitbucket repository. Every other launch repository is checked as a
 * member, so that every member of a V2 environment is authorized. An unpinned
 * GitHub launch is not checked again with its pin; that check is the pinned one.
 */
function launchIdentityAuthorizedByLaunchCheck(
  repository: SessionRepositoryRequest
): EnvironmentRepositoryIdentity | undefined {
  const covered =
    (repository.type === 'github' && repository.githubIntegrationId !== undefined) ||
    repository.type === 'bitbucket';
  return covered ? launchRepositoryIdentity(repository) : undefined;
}

/**
 * Authorizes every repository of a V2 environment before the session registers.
 * The first failure in environment order fails the start, and the error names
 * that repository. A V1 environment has no members to check.
 */
export async function assertEnvironmentRepositoriesAccess(
  input: AccessContext & {
    createdOnPlatform?: string;
    /** The launch repository of the session. */
    repository: SessionRepositoryRequest;
    environment:
      | { repositories?: readonly EnvironmentReferenceRepository[] | undefined }
      | undefined;
  }
): Promise<void> {
  const authorized = launchIdentityAuthorizedByLaunchCheck(input.repository);
  const members = (
    isMultiRepositoryEnvironment(input.environment) ? input.environment.repositories : []
  ).filter(
    member => authorized === undefined || !sameRepositoryIdentity(member.identity, authorized)
  );
  const failures = await Promise.all(
    members.map(member =>
      assertMemberAccess(input, member, input.repository).then(
        () => undefined,
        (error: unknown) => ({ member, error })
      )
    )
  );
  const failure = failures.find(result => result !== undefined);
  if (failure === undefined) return;
  const { member, error } = failure;
  throw new TRPCError({
    code: error instanceof TRPCError ? error.code : 'INTERNAL_SERVER_ERROR',
    message: `Repository ${member.repoFullName}: ${error instanceof TRPCError ? error.message : 'authorization failed'}`,
  });
}
