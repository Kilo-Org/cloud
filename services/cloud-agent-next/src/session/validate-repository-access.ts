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
  'service_incompatible',
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

type CloneSourceRepository = {
  repo?: string;
  githubIntegrationId?: string;
};

function sourceAccessDenied(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'source_access_denied' });
}

function isMissingAuthorizedSessionSourceRpc(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^The RPC receiver does not implement the method ["']resolveAuthorizedSessionSource["']\.?$/.test(
      error.message
    )
  );
}

async function readOptionalCloudAgentGitHubPin(input: {
  env: PersistenceEnv;
  userId: string;
  cloudAgentSessionId: string | undefined;
  authoritativeRepo: string | undefined;
}): Promise<string | undefined> {
  if (!input.cloudAgentSessionId) return undefined;
  const cloudAgentSessionId = input.cloudAgentSessionId;
  try {
    const sourceMetadata = await withDORetry(
      () => resolveSessionStub(input.env, input.userId, cloudAgentSessionId),
      stub => stub.getMetadata(),
      'CloudAgentSession.getMetadataForCloneRepository'
    );
    const metadataRepository = readGitHubRepository(sourceMetadata);
    if (
      !metadataRepository ||
      (input.authoritativeRepo &&
        !repositoriesMatch(input.authoritativeRepo, metadataRepository.repo))
    ) {
      return undefined;
    }
    return metadataRepository.githubIntegrationId;
  } catch {
    return undefined;
  }
}

async function resolveCloneSourceGitHubRepository(input: {
  env: PersistenceEnv;
  userId: string;
  orgId?: string;
  request: SessionCreateRequest;
}): Promise<CloneSourceRepository | null> {
  const sourceKiloSessionId = input.request.clone?.cloneFromKiloSessionId;
  if (!sourceKiloSessionId) return null;

  const sessionIngest = input.env.SESSION_INGEST;
  if (typeof sessionIngest?.resolveAuthorizedSessionSource === 'function') {
    let source;
    let methodUnavailable = false;
    try {
      source = await sessionIngest.resolveAuthorizedSessionSource({
        kiloUserId: input.userId,
        kiloSessionId: sourceKiloSessionId,
      });
    } catch (error) {
      if (!isMissingAuthorizedSessionSourceRpc(error)) {
        throw githubRepositoryAuthorizationError('source_unavailable');
      }
      methodUnavailable = true;
    }
    if (!methodUnavailable) {
      if (!source) throw sourceAccessDenied();
      if (source.organizationId !== (input.orgId ?? null)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'organization_mismatch' });
      }

      const repo = source.repository?.type === 'github' ? source.repository.repo : undefined;
      const githubIntegrationId = await readOptionalCloudAgentGitHubPin({
        env: input.env,
        userId: input.userId,
        cloudAgentSessionId: source.cloudAgentSessionId,
        authoritativeRepo: repo,
      });
      return {
        ...(repo ? { repo } : {}),
        ...(githubIntegrationId ? { githubIntegrationId } : {}),
      };
    }
  }

  // Rolling-deploy compatibility: an older Session Ingest worker can only
  // expose Cloud Agent roots. A missing mapping is not an authorization
  // decision; the final clone RPC retains the generic source access check.
  let source;
  if (!sessionIngest?.resolveCloudAgentRootSessionForKiloSession) return {};
  try {
    source = await sessionIngest.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: input.userId,
      kiloSessionId: sourceKiloSessionId,
    });
  } catch {
    throw githubRepositoryAuthorizationError('source_unavailable');
  }
  if (!source) return {};
  const mappedRepository = readGitHubRepository(source);
  const githubIntegrationId = await readOptionalCloudAgentGitHubPin({
    env: input.env,
    userId: input.userId,
    cloudAgentSessionId: source.cloudAgentSessionId,
    authoritativeRepo: mappedRepository?.repo,
  });
  return {
    ...(mappedRepository?.repo ? { repo: mappedRepository.repo } : {}),
    ...(githubIntegrationId ? { githubIntegrationId } : {}),
  };
}

/**
 * Resolves and pins GitHub repository identity before any operation-ledger or
 * session allocation work on non-ledger paths. Ledger-backed creates call this
 * only after admission and persist the pin with allocation progress. The token
 * is deliberately discarded: creation proves repository access, while delayed
 * workspace preparation reauthorizes the persisted integration exactly because
 * credentials may expire or access may be revoked between those phases.
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
  if (source?.repo && !repositoriesMatch(submitted.repo, source.repo)) {
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
      ...(source?.repo ? { repo: source.repo } : {}),
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
