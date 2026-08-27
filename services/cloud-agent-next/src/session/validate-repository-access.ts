import { TRPCError } from '@trpc/server';
import type { PersistenceEnv } from '../persistence/types.js';
import {
  isTemporaryManagedBitbucketTokenFailure,
  resolveGitHubTokenForRepo,
  resolveManagedBitbucketToken,
} from '../services/git-token-service-client.js';
import type { SessionCreateRequest, SessionRepositoryRequest } from './session-requests.js';
import { withDORetry } from '../utils/do-retry.js';
import { resolveSessionStub } from '../sandbox-session/session-stub.js';

const TEMPORARY_GITHUB_RESOLUTION_REASONS = new Set([
  'database_not_configured',
  'service_not_configured',
  'temporarily_unavailable',
  'rpc_error',
  'source_unavailable',
]);

function githubRepositoryAuthorizationError(reason: string): TRPCError {
  return new TRPCError({
    code: TEMPORARY_GITHUB_RESOLUTION_REASONS.has(reason) ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
    message: `GitHub repository authorization failed (${reason})`,
  });
}

function repositoriesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function readGitHubRepository(
  value: unknown
): { type: 'github'; repo: string; githubIntegrationId?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const repository = (value as { repository?: unknown }).repository;
  if (typeof repository !== 'object' || repository === null) return undefined;
  const fields = repository as {
    type?: unknown;
    repo?: unknown;
    githubIntegrationId?: unknown;
  };
  if (fields.type !== 'github' || typeof fields.repo !== 'string') return undefined;
  return {
    type: 'github',
    repo: fields.repo,
    ...(typeof fields.githubIntegrationId === 'string'
      ? { githubIntegrationId: fields.githubIntegrationId }
      : {}),
  };
}

async function resolveCloneSourceGitHubRepository(input: {
  env: PersistenceEnv;
  userId: string;
  request: SessionCreateRequest;
}): Promise<{ repo: string; githubIntegrationId?: string } | null> {
  const sourceKiloSessionId = input.request.clone?.cloneFromKiloSessionId;
  if (!sourceKiloSessionId) return null;

  let source;
  try {
    source = await input.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: input.userId,
      kiloSessionId: sourceKiloSessionId,
    });
  } catch {
    throw githubRepositoryAuthorizationError('source_unavailable');
  }
  if (!source) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'source_access_denied' });
  }

  let sourceMetadata: unknown;
  try {
    sourceMetadata = await withDORetry(
      () => resolveSessionStub(input.env, input.userId, source.cloudAgentSessionId),
      stub => stub.getMetadata(),
      'CloudAgentSession.getMetadataForCloneRepository'
    );
  } catch {
    throw githubRepositoryAuthorizationError('source_unavailable');
  }

  const metadataRepository = readGitHubRepository(sourceMetadata);
  if (!metadataRepository) {
    throw githubRepositoryAuthorizationError('source_unavailable');
  }
  const mappedRepository = readGitHubRepository(source);
  if (
    mappedRepository &&
    metadataRepository &&
    !repositoriesMatch(mappedRepository.repo, metadataRepository.repo)
  ) {
    throw githubRepositoryAuthorizationError('source_unavailable');
  }

  const repo = mappedRepository?.repo ?? metadataRepository.repo;
  return {
    repo,
    ...(metadataRepository.githubIntegrationId
      ? { githubIntegrationId: metadataRepository.githubIntegrationId }
      : {}),
  };
}

/**
 * Resolves and pins GitHub repository identity before any operation-ledger or
 * session allocation work. The returned request contains no resolved token.
 */
export async function canonicalizeRepositoryBeforeSessionCreation(input: {
  env: PersistenceEnv;
  userId: string;
  orgId?: string;
  request: SessionCreateRequest;
}): Promise<SessionCreateRequest> {
  if (input.request.repository.type !== 'github') return input.request;

  const submitted = input.request.repository;
  const source = await resolveCloneSourceGitHubRepository(input);
  if (source && !repositoriesMatch(submitted.repo, source.repo)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'clone_repository_mismatch' });
  }
  if (
    source?.githubIntegrationId &&
    submitted.githubIntegrationId &&
    source.githubIntegrationId.toLowerCase() !== submitted.githubIntegrationId.toLowerCase()
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'clone_integration_mismatch' });
  }

  const expectedIntegrationId = source?.githubIntegrationId ?? submitted.githubIntegrationId;
  const result = await resolveGitHubTokenForRepo(input.env, {
    githubRepo: source?.repo ?? submitted.repo,
    userId: input.userId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(expectedIntegrationId ? { expectedIntegrationId } : {}),
  });
  if (!result.success) throw githubRepositoryAuthorizationError(result.error.reason);

  return {
    ...input.request,
    repository: {
      ...submitted,
      ...(source ? { repo: source.repo } : {}),
      githubIntegrationId: result.value.platformIntegrationId,
    },
  };
}

export async function assertRepositoryAccessBeforeSessionCreation(input: {
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
