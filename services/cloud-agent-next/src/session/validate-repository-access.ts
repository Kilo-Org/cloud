import { TRPCError } from '@trpc/server';
import type { PersistenceEnv } from '../persistence/types.js';
import {
  isTemporaryManagedBitbucketTokenFailure,
  resolveGitHubTokenForRepo,
  resolveManagedBitbucketToken,
} from '../services/git-token-service-client.js';
import type { SessionRepositoryRequest } from './session-requests.js';

export async function assertRepositoryAccessBeforeSessionCreation(input: {
  env: PersistenceEnv;
  userId: string;
  orgId?: string;
  repository: SessionRepositoryRequest;
}): Promise<void> {
  if (input.repository.type === 'github' && input.repository.githubIntegrationId) {
    const result = await resolveGitHubTokenForRepo(input.env, {
      githubRepo: input.repository.repo,
      userId: input.userId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      expectedIntegrationId: input.repository.githubIntegrationId,
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
    return;
  }

  if (input.repository.type !== 'bitbucket') return;
  if (!input.orgId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repositories require an organization',
    });
  }

  const result = await resolveManagedBitbucketToken(input.env, {
    userId: input.userId,
    orgId: input.orgId,
    ...(input.repository.bitbucketIntegrationId
      ? { expectedIntegrationId: input.repository.bitbucketIntegrationId }
      : {}),
    workspaceUuid: input.repository.workspaceUuid,
    repositoryUuid: input.repository.repositoryUuid,
    repositoryUrl: input.repository.url,
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
