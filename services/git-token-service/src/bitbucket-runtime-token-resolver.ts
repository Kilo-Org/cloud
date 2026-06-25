import { getWorkerDb } from '@kilocode/db/client';
import { platform_integrations } from '@kilocode/db/schema';
import { BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  BitbucketApiError,
  listBitbucketWorkspaceRepositories,
  type BitbucketRepository,
  type BitbucketRepositoryApiOptions,
} from './bitbucket-api.js';
import {
  BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS,
  BitbucketAuthorizationService,
  type BitbucketAuthorizationResult,
} from './bitbucket-authorization-service.js';
import {
  BitbucketWorkspaceAccessTokenAuthorizationService,
  type BitbucketWorkspaceAccessTokenAuthorization,
  type BitbucketWorkspaceAccessTokenAuthorizationResult,
} from './bitbucket-workspace-access-token-authorization-service.js';
import { normalizeBitbucketUuid, parseBitbucketCloneUrl } from './bitbucket-url.js';

export type BitbucketRepositoryListResult =
  | { status: 'available'; repositories: BitbucketRepository[] }
  | { status: 'invalid_request' }
  | { status: 'not_connected' }
  | { status: 'reconnect_required' }
  | { status: 'insufficient_permissions' }
  | { status: 'temporarily_unavailable' };

export type GetBitbucketTokenParams = {
  userId: string;
  orgId?: string;
  integrationId?: string;
  workspaceUuid: string;
  repositoryUuid: string;
  repositoryUrl: string;
};

export type GetBitbucketTokenResult =
  | { success: true; token: string }
  | {
      success: false;
      reason:
        | 'invalid_request'
        | 'not_connected'
        | 'reconnect_required'
        | 'temporarily_unavailable'
        | 'insufficient_permissions'
        | 'workspace_mismatch'
        | 'repository_not_found'
        | 'repository_mismatch';
    };

const CachedRepositorySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

type CachedRepositoryLookupResult =
  | { status: 'available'; repository: BitbucketRepository }
  | { status: 'not_connected' }
  | { status: 'repository_not_found' }
  | { status: 'temporarily_unavailable' };

type AuthorizationService = {
  getAuthorization(input: {
    userId: string;
    orgId?: string;
  }): Promise<BitbucketWorkspaceAccessTokenAuthorizationResult>;
  invalidateAuthorization(
    authorization: BitbucketWorkspaceAccessTokenAuthorization,
    reason: 'provider_rejected' | 'workspace_mismatch'
  ): Promise<void>;
};
type OAuthAuthorizationService = {
  getAuthorization(
    input: {
      userId: string;
      orgId?: string;
    },
    minimumValidityMs?: number
  ): Promise<BitbucketAuthorizationResult>;
};
type RuntimeAuthorization =
  | (BitbucketWorkspaceAccessTokenAuthorization & { source: 'workspace_access_token' })
  | (Extract<BitbucketAuthorizationResult, { status: 'available' }> & { source: 'oauth' });

export type BitbucketRuntimeTokenResolverDependencies = {
  authorizationService: AuthorizationService;
  oauthAuthorizationService: OAuthAuthorizationService;
  listRepositories(options: BitbucketRepositoryApiOptions): Promise<BitbucketRepository[]>;
  findCachedRepository(input: {
    integrationId: string;
    organizationId: string;
    workspace: { uuid: string; slug: string };
    repositoryUuid: string;
  }): Promise<CachedRepositoryLookupResult>;
};

async function findCachedBitbucketRepository(
  env: CloudflareEnv,
  input: {
    integrationId: string;
    organizationId: string;
    workspace: { uuid: string; slug: string };
    repositoryUuid: string;
  }
): Promise<CachedRepositoryLookupResult> {
  if (!env.HYPERDRIVE) return { status: 'temporarily_unavailable' };

  try {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    const [integration] = await db
      .select({
        repositories: platform_integrations.repositories,
        repositoriesSyncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.owned_by_organization_id, input.organizationId),
          isNull(platform_integrations.owned_by_user_id),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
          eq(platform_integrations.integration_status, 'active'),
          isNull(platform_integrations.auth_invalid_at),
          eq(platform_integrations.platform_account_id, input.workspace.uuid),
          eq(platform_integrations.platform_account_login, input.workspace.slug)
        )
      )
      .limit(1);
    if (!integration) return { status: 'not_connected' };
    if (
      integration.repositories === null ||
      integration.repositoriesSyncedAt === null ||
      !Number.isFinite(new Date(integration.repositoriesSyncedAt).getTime())
    ) {
      return { status: 'temporarily_unavailable' };
    }

    const repositories = z
      .array(CachedRepositorySchema)
      .max(500)
      .safeParse(integration.repositories);
    if (!repositories.success) return { status: 'temporarily_unavailable' };
    const repository = repositories.data.find(candidate => candidate.id === input.repositoryUuid);
    if (!repository) return { status: 'repository_not_found' };
    return {
      status: 'available',
      repository: {
        id: repository.id,
        workspaceUuid: input.workspace.uuid,
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        ...(repository.default_branch ? { defaultBranch: repository.default_branch } : {}),
      },
    };
  } catch {
    return { status: 'temporarily_unavailable' };
  }
}

function dependencies(
  env: CloudflareEnv,
  overrides?: BitbucketRuntimeTokenResolverDependencies
): BitbucketRuntimeTokenResolverDependencies {
  if (overrides) return overrides;
  return {
    authorizationService: new BitbucketWorkspaceAccessTokenAuthorizationService(env),
    oauthAuthorizationService: new BitbucketAuthorizationService(env),
    listRepositories: listBitbucketWorkspaceRepositories,
    findCachedRepository: input => findCachedBitbucketRepository(env, input),
  };
}

type CanonicalProviderFailure =
  | 'invalid_request'
  | 'reconnect_required'
  | 'temporarily_unavailable'
  | 'insufficient_permissions'
  | 'workspace_mismatch';

async function classifyProviderError(
  error: BitbucketApiError,
  authorization: RuntimeAuthorization,
  authorizationService: AuthorizationService
): Promise<CanonicalProviderFailure> {
  switch (error.code) {
    case 'authentication_rejected':
      if (authorization.source === 'workspace_access_token') {
        const { source: _source, ...workspaceAuthorization } = authorization;
        await authorizationService.invalidateAuthorization(
          workspaceAuthorization,
          'provider_rejected'
        );
      }
      return 'reconnect_required';
    case 'workspace_mismatch':
      if (authorization.source === 'workspace_access_token') {
        const { source: _source, ...workspaceAuthorization } = authorization;
        await authorizationService.invalidateAuthorization(
          workspaceAuthorization,
          'workspace_mismatch'
        );
      }
      return 'workspace_mismatch';
    case 'insufficient_permissions':
      return 'insufficient_permissions';
    case 'not_found':
      return 'reconnect_required';
    case 'invalid_request':
      return 'invalid_request';
    case 'request_failed':
    case 'request_timed_out':
    case 'transport_failed':
    case 'rate_limited':
    case 'provider_unavailable':
    case 'redirect_rejected':
    case 'invalid_response':
    case 'invalid_pagination':
    case 'page_limit_exceeded':
    case 'item_limit_exceeded':
    case 'response_too_large':
      return 'temporarily_unavailable';
  }
}

function toRepositoryListFailure(
  failure: CanonicalProviderFailure
): Exclude<BitbucketRepositoryListResult, { status: 'available' }> {
  return { status: failure === 'workspace_mismatch' ? 'reconnect_required' : failure };
}

async function getRuntimeAuthorization(
  owner: { userId: string; orgId?: string },
  runtimeDependencies: BitbucketRuntimeTokenResolverDependencies,
  oauthMinimumValidityMs?: number
): Promise<
  | { status: 'available'; authorization: RuntimeAuthorization }
  | Exclude<BitbucketRepositoryListResult, { status: 'available' }>
> {
  const workspaceAccessTokenAuthorization =
    await runtimeDependencies.authorizationService.getAuthorization(owner);
  if (workspaceAccessTokenAuthorization.status === 'available') {
    return {
      status: 'available',
      authorization: { ...workspaceAccessTokenAuthorization, source: 'workspace_access_token' },
    };
  }
  if (workspaceAccessTokenAuthorization.status !== 'not_connected') {
    return workspaceAccessTokenAuthorization;
  }

  const oauthAuthorization =
    oauthMinimumValidityMs === undefined
      ? await runtimeDependencies.oauthAuthorizationService.getAuthorization(owner)
      : await runtimeDependencies.oauthAuthorizationService.getAuthorization(
          owner,
          oauthMinimumValidityMs
        );
  if (oauthAuthorization.status === 'available') {
    return {
      status: 'available',
      authorization: { ...oauthAuthorization, source: 'oauth' },
    };
  }
  if (oauthAuthorization.status === 'workspace_selection_required') {
    return { status: 'reconnect_required' };
  }
  return oauthAuthorization;
}

export async function listBitbucketRepositories(
  env: CloudflareEnv,
  owner: { userId: string; orgId?: string },
  dependencyOverrides?: BitbucketRuntimeTokenResolverDependencies
): Promise<BitbucketRepositoryListResult> {
  if (!owner.orgId) return { status: 'invalid_request' };
  const runtimeDependencies = dependencies(env, dependencyOverrides);
  const authorizationResult = await getRuntimeAuthorization(owner, runtimeDependencies);
  if (authorizationResult.status !== 'available') return authorizationResult;
  const authorization = authorizationResult.authorization;

  try {
    return {
      status: 'available',
      repositories: await runtimeDependencies.listRepositories({
        accessToken: authorization.token,
        workspace: authorization.workspace,
      }),
    };
  } catch (error) {
    if (error instanceof BitbucketApiError) {
      const failure = await classifyProviderError(
        error,
        authorization,
        runtimeDependencies.authorizationService
      );
      return toRepositoryListFailure(failure);
    }
    throw error;
  }
}

export async function resolveBitbucketToken(
  env: CloudflareEnv,
  params: GetBitbucketTokenParams,
  dependencyOverrides?: BitbucketRuntimeTokenResolverDependencies
): Promise<GetBitbucketTokenResult> {
  if (!params.orgId) return { success: false, reason: 'invalid_request' };
  const workspaceUuid = normalizeBitbucketUuid(params.workspaceUuid);
  const repositoryUuid = normalizeBitbucketUuid(params.repositoryUuid);
  const parsedUrl = parseBitbucketCloneUrl(params.repositoryUrl);
  if (!workspaceUuid || !repositoryUuid || !parsedUrl.success) {
    return { success: false, reason: 'invalid_request' };
  }

  const runtimeDependencies = dependencies(env, dependencyOverrides);
  const authorizationResult = await getRuntimeAuthorization(
    { userId: params.userId, orgId: params.orgId },
    runtimeDependencies,
    BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS
  );
  if (authorizationResult.status !== 'available') {
    return { success: false, reason: authorizationResult.status };
  }
  const authorization = authorizationResult.authorization;
  if (params.integrationId && params.integrationId !== authorization.integrationId) {
    return { success: false, reason: 'not_connected' };
  }
  if (
    authorization.workspace.uuid !== workspaceUuid ||
    authorization.workspace.slug !== parsedUrl.workspace
  ) {
    return { success: false, reason: 'workspace_mismatch' };
  }

  const cachedRepository = await runtimeDependencies.findCachedRepository({
    integrationId: authorization.integrationId,
    organizationId: params.orgId,
    workspace: authorization.workspace,
    repositoryUuid,
  });
  if (cachedRepository.status !== 'available') {
    return { success: false, reason: cachedRepository.status };
  }
  const repository = cachedRepository.repository;
  if (
    repository.id !== repositoryUuid ||
    repository.workspaceUuid !== workspaceUuid ||
    repository.fullName !== parsedUrl.fullName
  ) {
    return { success: false, reason: 'repository_mismatch' };
  }
  return { success: true, token: authorization.token };
}
