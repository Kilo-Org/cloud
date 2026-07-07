import { TRPCError } from '@trpc/server';
import type { PersistenceEnv } from '../persistence/types.js';
import {
  isTemporaryManagedBitbucketTokenFailure,
  resolveManagedBitbucketToken,
} from '../services/git-token-service-client.js';
import type { SessionRepositoryRequest } from './session-requests.js';

export async function assertBitbucketRepositoryAccessBeforeSessionCreation(input: {
  env: PersistenceEnv;
  userId: string;
  orgId?: string;
  repository: SessionRepositoryRequest;
}): Promise<void> {
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
