import { TRPCError } from '@trpc/server';
import type { PersistenceEnv } from '../persistence/types.js';
import { ResolvedRepositoryIdentitySchema } from '../persistence/session-metadata.js';
import {
  isTemporaryManagedBitbucketTokenFailure,
  isTemporaryManagedGitLabTokenFailure,
  resolveGitHubTokenForRepo,
  resolveManagedBitbucketToken,
  resolveManagedGitLabToken,
} from '../services/git-token-service-client.js';
import {
  normalizeRepositoryIdentity,
  type ResolvedRepositoryIdentity,
  type SessionRepositoryRequest,
} from './session-requests.js';

export async function assertRepositoryAccessBeforeSessionCreation(input: {
  env: PersistenceEnv;
  userId: string;
  orgId?: string;
  createdOnPlatform?: string;
  repository: SessionRepositoryRequest;
}): Promise<ResolvedRepositoryIdentity | undefined> {
  const repository = input.repository;
  const identity = normalizeRepositoryIdentity(repository);
  const resolvedId = identity.kind === 'resolved' ? identity.integrationId : undefined;
  if (repository.type === 'github') {
    // Unpinned old GitHub requests retain lazy authorization. Remove this fallback
    // after old clients/records disappear and the 30-day ledger window expires.
    if (!resolvedId && !repository.githubIntegrationId) return;
    const result = await resolveGitHubTokenForRepo(input.env, {
      githubRepo: repository.repo,
      userId: input.userId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      expectedIntegrationId: resolvedId ?? repository.githubIntegrationId,
      ...(identity.kind === 'resolved'
        ? { expectedIntegrationOwner: identity.integrationOwner }
        : {}),
    });
    if (!result.success || result.value.identity.kind !== 'resolved') {
      const reason = result.success ? 'service_compatibility_error' : result.error.reason;
      throw new TRPCError({
        code:
          reason === 'service_not_configured' ||
          reason === 'rpc_error' ||
          reason === 'service_compatibility_error'
            ? 'SERVICE_UNAVAILABLE'
            : 'BAD_REQUEST',
        message: `GitHub repository authorization failed (${reason})`,
      });
    }
    return result.value.identity;
  }

  if (repository.type === 'gitlab') {
    const result = await resolveManagedGitLabToken(input.env, {
      userId: input.userId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      repositoryUrl: repository.url,
      ...((resolvedId ?? repository.gitlabIntegrationId)
        ? { expectedIntegrationId: resolvedId ?? repository.gitlabIntegrationId }
        : {}),
      ...(input.createdOnPlatform ? { createdOnPlatform: input.createdOnPlatform } : {}),
    });
    if (!result.success) {
      throw new TRPCError({
        code: isTemporaryManagedGitLabTokenFailure(result.reason)
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST',
        message: `GitLab repository authorization failed (${result.reason})`,
      });
    }
    return ResolvedRepositoryIdentitySchema.parse({
      kind: 'resolved',
      integrationId: result.integrationId,
      integrationOwner: input.orgId
        ? { type: 'org', id: input.orgId }
        : { type: 'user', id: input.userId },
      instanceUrl: result.instanceUrl,
    });
  }

  if (repository.type !== 'bitbucket') return;
  if (!input.orgId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repositories require an organization',
    });
  }

  const result = await resolveManagedBitbucketToken(input.env, {
    userId: input.userId,
    orgId: input.orgId,
    ...((resolvedId ?? repository.bitbucketIntegrationId)
      ? { expectedIntegrationId: resolvedId ?? repository.bitbucketIntegrationId }
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
  return ResolvedRepositoryIdentitySchema.parse({
    kind: 'resolved',
    integrationId: result.integrationId,
    integrationOwner: { type: 'org', id: input.orgId },
    instanceUrl: 'https://bitbucket.org',
  });
}
