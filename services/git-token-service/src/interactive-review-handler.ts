import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  platform_integrations,
  platform_oauth_credentials,
  platform_access_token_credentials,
} from '@kilocode/db/schema';
import { hasRequiredBitbucketWorkspaceAccessTokenScopes } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { and, eq, isNull, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { BitbucketPullRequestRequestSchema } from './bitbucket-code-review-service.js';
import {
  BitbucketInteractiveMetadataSchema,
  BitbucketInteractiveRequestSchema,
  createBitbucketInteractiveApi,
  type BitbucketInteractiveRequest,
  type BitbucketInteractiveServiceSuccess,
} from './bitbucket-interactive-api.js';
import {
  BitbucketInteractiveError,
  assertBitbucketRequestSize,
  BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES,
} from './bitbucket-safe-transport.js';
import {
  resolveBitbucketCapabilitySubject,
  selectCachedBitbucketRepository,
  type GetBitbucketTokenResult,
} from './bitbucket-runtime-token-resolver.js';
import { BitbucketWorkspaceAccessTokenAuthorizationService } from './bitbucket-workspace-access-token-authorization-service.js';
import { normalizeBitbucketUuid } from './bitbucket-url.js';

export const BitbucketInteractiveHttpRequestSchema = BitbucketPullRequestRequestSchema.omit({
  owner: true,
  pullRequestId: true,
}).extend({ request: BitbucketInteractiveRequestSchema });
type Owner = { userId: string; orgId: string };
type Target = z.infer<typeof BitbucketInteractiveHttpRequestSchema>;
type FailureReason =
  | BitbucketInteractiveError['code']
  | Exclude<Extract<GetBitbucketTokenResult, { success: false }>['reason'], 'repository_not_found'>;

export function buildBitbucketInteractiveIntegrationQuery(
  db: WorkerDb,
  owner: Owner,
  integrationId: string
) {
  return db
    .select({
      integrationId: platform_integrations.id,
      integrationType: platform_integrations.integration_type,
      workspaceUuid: platform_integrations.platform_account_id,
      workspaceSlug: platform_integrations.platform_account_login,
      scopes: platform_integrations.scopes,
      repositories: platform_integrations.repositories,
      repositoriesSyncedAt: platform_integrations.repositories_synced_at,
      oauthId: platform_oauth_credentials.id,
      actorId: platform_oauth_credentials.provider_subject_id,
      actorLogin: platform_oauth_credentials.provider_subject_login,
      accessId: platform_access_token_credentials.id,
      accessVersion: platform_access_token_credentials.credential_version,
      accessScopes: platform_access_token_credentials.provider_scopes,
    })
    .from(platform_integrations)
    .innerJoin(
      kilocode_users,
      and(eq(kilocode_users.id, owner.userId), isNull(kilocode_users.blocked_reason))
    )
    .leftJoin(
      organization_memberships,
      and(
        eq(
          organization_memberships.organization_id,
          platform_integrations.owned_by_organization_id
        ),
        eq(organization_memberships.kilo_user_id, owner.userId)
      )
    )
    .leftJoin(
      platform_oauth_credentials,
      and(
        eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id),
        isNull(platform_oauth_credentials.revoked_at)
      )
    )
    .leftJoin(
      platform_access_token_credentials,
      and(
        eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id),
        isNull(platform_access_token_credentials.provider_resource_id)
      )
    )
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, 'bitbucket'),
        eq(platform_integrations.owned_by_organization_id, owner.orgId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.integration_status, 'active'),
        isNull(platform_integrations.auth_invalid_at),
        or(isNotNull(organization_memberships.id), eq(kilocode_users.is_admin, true))
      )
    )
    .limit(1);
}

type Integration = Awaited<ReturnType<typeof buildBitbucketInteractiveIntegrationQuery>>[number];
function checkTarget(integration: Integration, target: Target): FailureReason | null {
  if (integration.integrationId !== target.integrationId) return 'integration_mismatch';
  if (
    integration.workspaceUuid !== target.workspaceUuid ||
    integration.workspaceSlug !== target.workspaceSlug
  )
    return 'workspace_mismatch';
  if (
    !integration.repositoriesSyncedAt ||
    !Number.isFinite(new Date(integration.repositoriesSyncedAt).getTime())
  )
    return 'temporarily_unavailable';
  const cached = selectCachedBitbucketRepository(integration.repositories, target);
  if (cached.status !== 'available')
    return cached.status === 'repository_not_found' ? 'not_found' : cached.status;
  return cached.repository.fullName === target.repositoryFullName ? null : 'repository_mismatch';
}

const pullRequestWriteOperations = new Set([
  'approve',
  'unapprove',
  'requestChanges',
  'removeChangeRequest',
  'merge',
]);
function hasOperationScopes(scopes: readonly string[], operation: string): boolean {
  return (
    hasRequiredBitbucketWorkspaceAccessTokenScopes(scopes) &&
    (!pullRequestWriteOperations.has(operation) || scopes.includes('pullrequest:write'))
  );
}

export async function handleBitbucketInteractiveReview(
  env: CloudflareEnv,
  owner: Owner,
  input: unknown
): Promise<BitbucketInteractiveServiceSuccess | { success: false; reason: FailureReason }> {
  try {
    const parsed = BitbucketInteractiveHttpRequestSchema.safeParse(input);
    if (!parsed.success || !BitbucketPullRequestRequestSchema.shape.owner.safeParse(owner).success)
      return { success: false, reason: 'invalid_request' };
    const target = parsed.data;
    assertBitbucketRequestSize(JSON.stringify(target), BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES);
    const request = target.request;
    const path = request.params.path;
    const repositorySlug = target.repositoryFullName.split('/')[1];
    if (
      target.repositoryFullName !== `${target.workspaceSlug}/${repositorySlug}` ||
      (path.workspace !== target.workspaceSlug &&
        normalizeBitbucketUuid(String(path.workspace)) !== target.workspaceUuid) ||
      (path.repo_slug !== repositorySlug &&
        normalizeBitbucketUuid(String(path.repo_slug)) !== target.repositoryUuid)
    )
      return { success: false, reason: 'repository_mismatch' };
    if (!env.HYPERDRIVE) return { success: false, reason: 'temporarily_unavailable' };
    const query = buildBitbucketInteractiveIntegrationQuery(
      getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 }),
      owner,
      target.integrationId
    );
    const [initial] = await query;
    if (!initial) return { success: false, reason: 'not_connected' };
    const targetFailure = checkTarget(initial, target);
    if (targetFailure) return { success: false, reason: targetFailure };
    const scopes =
      initial.integrationType === 'workspace_access_token' ? initial.accessScopes : initial.scopes;
    if (!hasOperationScopes(scopes ?? [], request.operation))
      return { success: false, reason: 'insufficient_permissions' };
    const resolved = await resolveBitbucketCapabilitySubject(env, {
      ...owner,
      expectedIntegrationId: target.integrationId,
      workspaceUuid: target.workspaceUuid,
      repositoryUuid: target.repositoryUuid,
      repositoryUrl: `https://bitbucket.org/${target.repositoryFullName}.git`,
    });
    if (!resolved.success)
      return {
        success: false,
        reason: resolved.reason === 'repository_not_found' ? 'not_found' : resolved.reason,
      };
    const { subject } = resolved;
    const [current] = await query;
    if (!current || current.integrationType !== initial.integrationType)
      return { success: false, reason: 'reconnect_required' };
    const currentFailure = checkTarget(current, target);
    if (currentFailure) return { success: false, reason: currentFailure };
    const workspaceToken = current.integrationType === 'workspace_access_token';
    if (
      workspaceToken
        ? !current.accessId ||
          !current.accessVersion ||
          current.accessId !== initial.accessId ||
          current.accessVersion !== initial.accessVersion
        : current.integrationType !== 'oauth' ||
          !current.oauthId ||
          current.oauthId !== initial.oauthId ||
          current.actorId !== initial.actorId
    )
      return { success: false, reason: 'reconnect_required' };
    const metadata = BitbucketInteractiveMetadataSchema.safeParse({
      actorUserId: owner.userId,
      organizationId: owner.orgId,
      integrationId: subject.integrationId,
      instanceUrl: 'https://bitbucket.org',
      providerActor: workspaceToken
        ? {
            credentialKind: 'bitbucketWorkspaceToken',
            workspaceUuid: subject.workspaceUuid,
            workspaceSlug: subject.workspaceSlug,
          }
        : {
            credentialKind: 'bitbucketOAuth',
            actor: {
              provider: 'bitbucket',
              instanceUrl: 'https://bitbucket.org',
              id: current.actorId,
              login: current.actorLogin,
              displayName: null,
              avatarUrl: null,
            },
          },
      grants: { scopes: workspaceToken ? current.accessScopes : current.scopes },
    });
    if (!metadata.success) return { success: false, reason: 'reconnect_required' };
    if (!hasOperationScopes(metadata.data.grants.scopes, request.operation))
      return { success: false, reason: 'insufficient_permissions' };
    // Address the authorized repository by immutable UUID, never by a reused slug.
    const scope = {
      kind: 'repository' as const,
      workspace: `{${subject.workspaceUuid}}`,
      repository: `{${subject.repositoryUuid}}`,
    };
    const api = createBitbucketInteractiveApi({ scope, accessToken: subject.token });
    const params = {
      ...request.params,
      path: { ...path, workspace: scope.workspace, repo_slug: scope.repository },
    };
    try {
      let body = request.body;
      if (request.operation === 'merge') {
        // Omission inherits the PR's deletion preference. Require explicit deletion authorization.
        const mergeBody = z
          .object({ close_source_branch: z.boolean().default(false) })
          .catchall(z.json())
          .safeParse(body === undefined ? {} : body);
        if (!mergeBody.success) return { success: false, reason: 'invalid_request' };
        body = mergeBody.data;
        if (mergeBody.data.close_source_branch) {
          if (typeof path.pull_request_id !== 'number')
            return { success: false, reason: 'invalid_request' };
          const review = await api.execute({
            operation: 'pullRequest',
            params: { path: { ...params.path, pull_request_id: path.pull_request_id } },
          });
          const source = z
            .object({ source: z.object({ repository: z.object({ uuid: z.string() }) }) })
            .safeParse(review.data);
          // Destination access never grants deletion in a fork. This read is not an atomic head guard.
          if (
            !source.success ||
            normalizeBitbucketUuid(source.data.source.repository.uuid) !== target.repositoryUuid
          )
            return { success: false, reason: 'repository_mismatch' };
        }
      }
      // The shared schema and SDK validate this operation's dynamic path/body before dispatch.
      const result = await api.execute({ ...request, params, body } as BitbucketInteractiveRequest);
      return { success: true, result, metadata: metadata.data };
    } catch (error) {
      if (
        error instanceof BitbucketInteractiveError &&
        error.code === 'authentication_rejected' &&
        workspaceToken &&
        current.accessId &&
        current.accessVersion
      ) {
        await new BitbucketWorkspaceAccessTokenAuthorizationService(env).invalidateAuthorization(
          {
            status: 'available',
            token: subject.token,
            organizationId: owner.orgId,
            integrationId: subject.integrationId,
            credentialId: current.accessId,
            credentialVersion: current.accessVersion,
            providerScopes: metadata.data.grants.scopes,
            workspace: { uuid: subject.workspaceUuid, slug: subject.workspaceSlug },
          },
          'provider_rejected'
        );
      }
      throw error;
    }
  } catch (error) {
    return {
      success: false,
      reason: error instanceof BitbucketInteractiveError ? error.code : 'temporarily_unavailable',
    };
  }
}
