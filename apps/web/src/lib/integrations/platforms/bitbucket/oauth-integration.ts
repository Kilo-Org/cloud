import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import {
  scheduleBitbucketRepositoryCachePrime,
  listBitbucketRepositories,
} from './repository-cache';
import { BitbucketIntegrationMetadataSchema, type BitbucketWorkspace } from './metadata';
import { BitbucketRepositorySchema, withBitbucketRepositoryIdentity } from './token-service-client';
import type { LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import {
  createBitbucketInteractiveClient,
  BitbucketInteractiveClientError,
} from './interactive-client';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';

const CachedRepositorySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? and(
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id)
      )
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

function oauthIntegrationCondition(owner: Owner, integrationId?: string) {
  const conditions = [
    ownerCondition(owner),
    eq(platform_integrations.platform, PLATFORM.BITBUCKET),
    eq(platform_integrations.integration_type, 'oauth'),
  ];
  if (integrationId) {
    conditions.push(eq(platform_integrations.id, integrationId));
  }
  return and(...conditions);
}

function emptyRepositoryCache() {
  return {
    status: 'uninitialized' as const,
    repositories: [],
    syncedAt: null,
  };
}

function readCachedRepositories(
  value: unknown,
  syncedAt: string | null,
  workspace: BitbucketWorkspace,
  owner: Owner,
  integrationId: string
) {
  if (value === null || syncedAt === null) return emptyRepositoryCache();
  const repositories = z.array(CachedRepositorySchema).safeParse(value);
  if (!repositories.success) return emptyRepositoryCache();

  return {
    status: 'available' as const,
    repositories: repositories.data.map(repository =>
      withBitbucketRepositoryIdentity(
        {
          id: repository.id,
          workspaceUuid: workspace.uuid,
          name: repository.name,
          fullName: repository.full_name,
          private: repository.private,
          defaultBranch: repository.default_branch,
        },
        owner,
        integrationId
      )
    ),
    syncedAt: new Date(syncedAt).toISOString(),
  };
}

function projectWorkspace(workspace: BitbucketWorkspace) {
  return {
    uuid: workspace.uuid,
    slug: workspace.slug,
    displayName: workspace.name,
  };
}

async function findBitbucketOAuthIntegration(owner: Owner) {
  const [row] = await db
    .select({
      integrationId: platform_integrations.id,
      integrationStatus: platform_integrations.integration_status,
      metadata: platform_integrations.metadata,
      repositories: platform_integrations.repositories,
      repositoriesSyncedAt: platform_integrations.repositories_synced_at,
      nickname: platform_oauth_credentials.provider_subject_login,
      revokedAt: platform_oauth_credentials.revoked_at,
      credentialId: platform_oauth_credentials.id,
    })
    .from(platform_integrations)
    .leftJoin(
      platform_oauth_credentials,
      eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
    )
    .where(oauthIntegrationCondition(owner))
    .limit(1);
  return row ?? null;
}

export async function getBitbucketOAuthIntegrationStatus(owner: Owner, canManage: boolean) {
  const row = await findBitbucketOAuthIntegration(owner);
  if (!row) return null;

  const base = {
    method: 'oauth' as const,
    integrationId: row.integrationId,
    integrationStatus: row.integrationStatus,
    invalidatedAt: null,
    invalidationReason: null,
    expiresAt: null,
    lastValidatedAt: null,
    repositoryCache: emptyRepositoryCache(),
    canManage,
  };

  const metadata = BitbucketIntegrationMetadataSchema.safeParse(row.metadata);
  const authorizingNickname = row.nickname ?? null;
  if (!row.credentialId || !row.nickname || row.revokedAt || !metadata.success) {
    return {
      ...base,
      status: 'reconnect_required' as const,
      recoveryAction: 'disconnect_and_connect' as const,
      workspace: null,
      authorizingNickname,
    };
  }

  if (
    row.integrationStatus === INTEGRATION_STATUS.PENDING &&
    metadata.data.state === 'workspace_selection_required'
  ) {
    return {
      ...base,
      status: 'workspace_selection_required' as const,
      recoveryAction: null,
      workspace: null,
      authorizingNickname: canManage ? authorizingNickname : null,
      availableWorkspaces: canManage ? metadata.data.availableWorkspaces : [],
    };
  }

  if (row.integrationStatus === INTEGRATION_STATUS.ACTIVE && metadata.data.state === 'active') {
    return {
      ...base,
      status: 'connected' as const,
      recoveryAction: null,
      workspace: projectWorkspace(metadata.data.workspace),
      authorizingNickname,
      repositoryCache: readCachedRepositories(
        row.repositories,
        row.repositoriesSyncedAt,
        metadata.data.workspace,
        owner,
        row.integrationId
      ),
    };
  }

  return {
    ...base,
    status: 'reconnect_required' as const,
    recoveryAction: 'disconnect_and_connect' as const,
    workspace: null,
    authorizingNickname,
  };
}

export async function selectBitbucketOAuthWorkspace(input: {
  owner: Owner;
  kiloUserId: string;
  workspaceUuid: string;
  workspaceSlug: string;
}) {
  const row = await findBitbucketOAuthIntegration(input.owner);
  if (!row || row.integrationStatus !== INTEGRATION_STATUS.PENDING || row.revokedAt) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Reconnect Bitbucket first' });
  }

  const metadata = BitbucketIntegrationMetadataSchema.safeParse(row.metadata);
  if (!metadata.success || metadata.data.state !== 'workspace_selection_required') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Reconnect Bitbucket first' });
  }
  const selectedWorkspace = metadata.data.availableWorkspaces.find(
    workspace => workspace.uuid === input.workspaceUuid && workspace.slug === input.workspaceSlug
  );
  if (!selectedWorkspace) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select an available workspace' });
  }

  const activeMetadata = BitbucketIntegrationMetadataSchema.parse({
    state: 'active',
    workspace: selectedWorkspace,
  });
  const [updated] = await db
    .update(platform_integrations)
    .set({
      platform_installation_id: selectedWorkspace.uuid,
      platform_account_id: selectedWorkspace.uuid,
      platform_account_login: selectedWorkspace.slug,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: activeMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(platform_integrations.id, row.integrationId),
        oauthIntegrationCondition(input.owner),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING)
      )
    )
    .returning({ id: platform_integrations.id });
  if (!updated) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Bitbucket connection changed' });
  }
  scheduleBitbucketRepositoryCachePrime({
    owner: input.owner,
    kiloUserId: input.kiloUserId,
    integrationId: row.integrationId,
  });
  return { success: true, workspace: selectedWorkspace };
}

export async function disconnectBitbucketOAuthIntegration(input: {
  owner: Owner;
  integrationId?: string;
}) {
  const [deleted] = await db
    .delete(platform_integrations)
    .where(oauthIntegrationCondition(input.owner, input.integrationId))
    .returning({ id: platform_integrations.id });
  if (!deleted) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The Bitbucket integration was not found' });
  }
  return { success: true, integrationId: deleted.id };
}

export async function refreshBitbucketOAuthRepositories(input: {
  owner: Owner;
  kiloUserId: string;
  expectedIntegrationId: string;
}) {
  return listBitbucketRepositories({
    owner: input.owner,
    kiloUserId: input.kiloUserId,
    forceRefresh: true,
    expectedIntegrationId: input.expectedIntegrationId,
  });
}

export async function listBitbucketRepositoryBranches(input: {
  actorUserId: string;
  organizationId: string;
  reference: LaunchRepositoryReference;
  cursor?: string;
}) {
  const { repository, authorization } = input.reference;
  if (
    repository.provider !== 'bitbucket' ||
    authorization.owner.type !== 'org' ||
    authorization.owner.id !== input.organizationId
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Bitbucket repositories require the selected organization',
    });
  }
  const [workspaceSlug, repositorySlug, extra] = repository.fullName.split('/');
  if (
    !workspaceSlug ||
    !repositorySlug ||
    extra ||
    repository.instanceUrl !== 'https://bitbucket.org'
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Bitbucket repository' });
  }
  const client = createBitbucketInteractiveClient({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    workspace: {
      integrationId: authorization.integrationId,
      workspaceUuid: repository.workspaceUuid,
      workspaceSlug,
    },
    repository: {
      repositoryUuid: repository.repositoryId,
      repositoryFullName: repository.fullName,
    },
  });
  try {
    const result = await client.execute({
      operation: 'branches',
      params: {
        path: { workspace: workspaceSlug, repo_slug: repositorySlug },
      },
      ...(input.cursor ? { next: input.cursor } : {}),
    });
    if (
      result.status !== 200 ||
      result.metadata.integrationId !== authorization.integrationId ||
      result.metadata.organizationId !== input.organizationId ||
      result.metadata.actorUserId !== input.actorUserId
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Bitbucket integration changed',
      });
    }
    const page = z
      .object({ values: z.array(z.object({ name: z.string().min(1) })).max(50) })
      .safeParse(result.data);
    if (!page.success)
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to fetch Bitbucket branches',
      });
    return {
      branches: page.data.values.map(branch => ({
        name: branch.name,
        isDefault: branch.name === repository.defaultBranch,
      })),
      defaultBranch: repository.defaultBranch,
      // The b1/a3 service validates next links against this exact endpoint and query.
      nextCursor: result.next ?? null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof BitbucketInteractiveClientError) {
      if (
        [
          'not_connected',
          'reconnect_required',
          'insufficient_permissions',
          'authentication_rejected',
        ].includes(error.code)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bitbucket repository access denied' });
      }
      if (
        ['integration_mismatch', 'workspace_mismatch', 'repository_mismatch', 'not_found'].includes(
          error.code
        )
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Bitbucket repository not found' });
      }
      if (['invalid_request', 'invalid_pagination'].includes(error.code)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Bitbucket branch request' });
      }
    }
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Failed to fetch Bitbucket branches',
    });
  }
}

export const BitbucketOrganizationRepositoryListResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      repositories: z.array(BitbucketRepositorySchema),
      syncedAt: z.iso.datetime(),
    })
    .strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('workspace_selection_required') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('insufficient_permissions') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
]);

export type BitbucketOrganizationRepositoryListResult = z.infer<
  typeof BitbucketOrganizationRepositoryListResultSchema
>;
