import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { BitbucketOAuthCredentialRowSchema } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { captureException, captureMessage } from '@sentry/nextjs';
import { after } from 'next/server';
import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import {
  REPOSITORY_READ_LIMITS,
  type RepositoryReadOptions,
} from '@/lib/integrations/core/repository-read-limits';
import { BitbucketIntegrationMetadataSchema, type BitbucketWorkspace } from './metadata';
import {
  BitbucketRepositorySchema,
  fetchBitbucketRepositoriesFromTokenService,
} from './token-service-client';

const CachedBitbucketRepositorySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

export const CachedBitbucketRepositoryListResultSchema = z.discriminatedUnion('status', [
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

export type CachedBitbucketRepositoryListResult = z.infer<
  typeof CachedBitbucketRepositoryListResultSchema
>;

type ListBitbucketRepositoriesInput = {
  owner: Owner;
  kiloUserId: string;
  forceRefresh?: boolean;
  expectedIntegrationId?: string;
  readOptions?: RepositoryReadOptions;
};

type PrimeBitbucketRepositoryCacheInput = {
  owner: Owner;
  kiloUserId: string;
  integrationId: string;
};

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? and(
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id)
      )
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

function readCachedRepositories(
  value: unknown,
  syncedAt: string | null,
  workspace: BitbucketWorkspace,
  readOptions?: RepositoryReadOptions
): Extract<CachedBitbucketRepositoryListResult, { status: 'available' }> | null {
  if (value === null || !syncedAt) return null;
  const selected =
    readOptions?.bounded && Array.isArray(value)
      ? value.slice(0, REPOSITORY_READ_LIMITS.repositories)
      : value;
  const repositories = z.array(CachedBitbucketRepositorySchema).safeParse(selected);
  if (!repositories.success) return null;
  return {
    status: 'available',
    repositories: repositories.data.map(repository => ({
      id: repository.id,
      workspaceUuid: workspace.uuid,
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
    })),
    syncedAt: new Date(syncedAt).toISOString(),
  };
}

export async function listBitbucketRepositories({
  owner,
  kiloUserId,
  forceRefresh = false,
  expectedIntegrationId,
  readOptions,
}: ListBitbucketRepositoriesInput): Promise<CachedBitbucketRepositoryListResult> {
  readOptions?.signal?.throwIfAborted();
  const load = () =>
    db
      .select({
        integrationId: platform_integrations.id,
        integrationStatus: platform_integrations.integration_status,
        suspendedAt: platform_integrations.suspended_at,
        authInvalidAt: platform_integrations.auth_invalid_at,
        installationId: platform_integrations.platform_installation_id,
        accountId: platform_integrations.platform_account_id,
        accountLogin: platform_integrations.platform_account_login,
        metadata: platform_integrations.metadata,
        repositories: platform_integrations.repositories,
        repositoriesSyncedAt: platform_integrations.repositories_synced_at,
        credential: platform_oauth_credentials,
      })
      .from(platform_integrations)
      .leftJoin(
        platform_oauth_credentials,
        eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
      )
      .where(and(ownerCondition(owner), eq(platform_integrations.platform, PLATFORM.BITBUCKET)))
      .limit(1);
  const [row] = await load();

  if (!row) return { status: 'not_connected' };
  if (expectedIntegrationId && row.integrationId !== expectedIntegrationId) {
    return { status: 'temporarily_unavailable' };
  }
  const credential = BitbucketOAuthCredentialRowSchema.safeParse(row.credential);
  if (!credential.success || credential.data.revoked_at) {
    return { status: 'reconnect_required' };
  }
  if (readOptions?.bounded && (row.suspendedAt || row.authInvalidAt)) {
    return { status: 'reconnect_required' };
  }

  const metadata = BitbucketIntegrationMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return { status: 'reconnect_required' };
  if (
    row.integrationStatus === INTEGRATION_STATUS.PENDING &&
    metadata.data.state === 'workspace_selection_required'
  ) {
    return { status: 'workspace_selection_required' };
  }
  if (
    row.integrationStatus !== INTEGRATION_STATUS.ACTIVE ||
    metadata.data.state !== 'active' ||
    row.installationId !== metadata.data.workspace.uuid ||
    row.accountId !== metadata.data.workspace.uuid ||
    row.accountLogin !== metadata.data.workspace.slug
  ) {
    return { status: 'reconnect_required' };
  }

  const cachedResult = readCachedRepositories(
    row.repositories,
    row.repositoriesSyncedAt,
    metadata.data.workspace,
    readOptions
  );
  if (!forceRefresh && cachedResult) return cachedResult;

  readOptions?.signal?.throwIfAborted();
  const result = readOptions?.bounded
    ? await fetchBitbucketRepositoriesFromTokenService(
        kiloUserId,
        owner.type === 'org' ? owner.id : undefined,
        readOptions
      ).catch(() => ({ status: 'temporarily_unavailable' as const }))
    : await fetchBitbucketRepositoriesFromTokenService(
        kiloUserId,
        owner.type === 'org' ? owner.id : undefined
      );
  if (readOptions?.bounded) {
    readOptions.signal?.throwIfAborted();
    const [current] = await load();
    const currentCredential = BitbucketOAuthCredentialRowSchema.safeParse(current?.credential);
    if (
      !current ||
      !currentCredential.success ||
      current.integrationId !== row.integrationId ||
      current.integrationStatus !== row.integrationStatus ||
      current.suspendedAt !== row.suspendedAt ||
      current.authInvalidAt !== row.authInvalidAt ||
      current.installationId !== row.installationId ||
      current.accountId !== row.accountId ||
      current.accountLogin !== row.accountLogin ||
      JSON.stringify(current.metadata) !== JSON.stringify(row.metadata) ||
      current.repositoriesSyncedAt !== row.repositoriesSyncedAt ||
      currentCredential.data.id !== credential.data.id ||
      currentCredential.data.credential_version !== credential.data.credential_version ||
      currentCredential.data.revoked_at !== credential.data.revoked_at
    ) {
      return listBitbucketRepositories({ owner, kiloUserId, expectedIntegrationId, readOptions });
    }
    if (result.status !== 'available') return result;
    return {
      status: 'available',
      repositories: result.repositories.slice(0, REPOSITORY_READ_LIMITS.repositories),
      syncedAt: new Date().toISOString(),
    };
  }
  if (result.status !== 'available') return result;

  const repositories = result.repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
    default_branch: repository.defaultBranch,
  }));
  const previousSyncedAtMs = row.repositoriesSyncedAt
    ? new Date(row.repositoriesSyncedAt).getTime()
    : 0;
  const syncedAt = new Date(
    Math.max(Date.now(), Number.isFinite(previousSyncedAtMs) ? previousSyncedAtMs + 1 : 0)
  ).toISOString();
  const cacheVersionCondition = row.repositoriesSyncedAt
    ? eq(platform_integrations.repositories_synced_at, row.repositoriesSyncedAt)
    : isNull(platform_integrations.repositories_synced_at);
  const [updated] = await db
    .update(platform_integrations)
    .set({
      repositories,
      repositories_synced_at: syncedAt,
      auth_invalid_at: null,
      auth_invalid_reason: null,
      updated_at: syncedAt,
    })
    .where(
      and(
        eq(platform_integrations.id, row.integrationId),
        ownerCondition(owner),
        eq(platform_integrations.platform, PLATFORM.BITBUCKET),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
        cacheVersionCondition,
        eq(platform_integrations.platform_installation_id, metadata.data.workspace.uuid),
        eq(platform_integrations.platform_account_id, metadata.data.workspace.uuid),
        eq(platform_integrations.platform_account_login, metadata.data.workspace.slug)
      )
    )
    .returning({ id: platform_integrations.id });
  if (!updated) {
    return listBitbucketRepositories({ owner, kiloUserId });
  }

  return {
    ...result,
    syncedAt,
  };
}

export function scheduleBitbucketRepositoryCachePrime(
  input: PrimeBitbucketRepositoryCacheInput
): void {
  after(() => primeBitbucketRepositoryCache(input));
}

export async function primeBitbucketRepositoryCache({
  owner,
  kiloUserId,
  integrationId,
}: PrimeBitbucketRepositoryCacheInput): Promise<void> {
  try {
    const result = await listBitbucketRepositories({
      owner,
      kiloUserId,
      forceRefresh: true,
      expectedIntegrationId: integrationId,
    });
    if (result.status !== 'available') {
      captureMessage('Bitbucket repository cache prime failed', {
        level: 'warning',
        tags: { source: 'bitbucket_repository_cache', operation: 'prime' },
        extra: { integrationId, ownerType: owner.type, status: result.status },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'bitbucket_repository_cache', operation: 'prime' },
      extra: { integrationId, ownerType: owner.type },
    });
  }
}
