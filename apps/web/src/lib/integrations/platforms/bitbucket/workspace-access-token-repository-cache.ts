import 'server-only';

import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  getUnexpectedBitbucketWorkspaceAccessTokenScopes,
  hasRequiredBitbucketWorkspaceAccessTokenScopes,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { platform_access_token_credentials, platform_integrations } from '@kilocode/db/schema';
import { and, eq, exists, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { BitbucketWorkspaceAccessTokenMetadataSchema } from './metadata';
import {
  BitbucketRepositorySchema,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService,
} from './token-service-client';
import {
  BitbucketWorkspaceAccessTokenOrganizationAuthorizationError,
  lockBitbucketWorkspaceAccessTokenOrganization,
  requireBitbucketWorkspaceAccessTokenOrganizationManager,
} from './workspace-access-token-organization-authorization';

const WorkspaceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/);
const InvalidationReasonSchema = z.enum(BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS);

const CachedRepositorySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

export const BitbucketWorkspaceAccessTokenRepositoryListResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('available'),
        repositories: z.array(BitbucketRepositorySchema),
        syncedAt: z.iso.datetime(),
      })
      .strict(),
    z.object({ status: z.literal('not_connected') }).strict(),
    z.object({ status: z.literal('reconnect_required') }).strict(),
    z.object({ status: z.literal('insufficient_permissions') }).strict(),
    z.object({ status: z.literal('temporarily_unavailable') }).strict(),
    z.object({ status: z.literal('invalid_request') }).strict(),
  ]
);

export type BitbucketWorkspaceAccessTokenRepositoryListResult = z.infer<
  typeof BitbucketWorkspaceAccessTokenRepositoryListResultSchema
>;

type AvailableRepositoryCache = Extract<
  BitbucketWorkspaceAccessTokenRepositoryListResult,
  { status: 'available' }
>;

type ReadCachedRepositoriesInput = {
  organizationId: string;
  expectedIntegrationId?: string;
};

type RefreshRepositoriesInput = {
  organizationId: string;
  kiloUserId: string;
  expectedIntegrationId: string;
};

type WorkspaceIdentity = {
  uuid: string;
  slug: string;
};

export class BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError extends Error {
  constructor() {
    super('The current user cannot refresh this organization integration');
    this.name = 'BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError';
  }
}

function canonicalizeUuid(value: string): string | null {
  const canonical = value.toLowerCase();
  return value.trim() === value && z.uuid().safeParse(canonical).success ? canonical : null;
}

async function loadIntegration(organizationId: string) {
  const [row] = await db
    .select({
      integrationId: platform_integrations.id,
      integrationStatus: platform_integrations.integration_status,
      installationId: platform_integrations.platform_installation_id,
      workspaceUuid: platform_integrations.platform_account_id,
      workspaceSlug: platform_integrations.platform_account_login,
      metadata: platform_integrations.metadata,
      repositories: platform_integrations.repositories,
      repositoriesSyncedAt: platform_integrations.repositories_synced_at,
      authInvalidAt: platform_integrations.auth_invalid_at,
      authInvalidReason: platform_integrations.auth_invalid_reason,
      credentialId: platform_access_token_credentials.id,
      credentialOrganizationId: platform_access_token_credentials.owned_by_organization_id,
      credentialPlatform: platform_access_token_credentials.platform,
      credentialIntegrationType: platform_access_token_credentials.integration_type,
      providerCredentialType: platform_access_token_credentials.provider_credential_type,
      providerScopes: platform_access_token_credentials.provider_scopes,
      providerVerifiedAt: platform_access_token_credentials.provider_verified_at,
      credentialVersion: platform_access_token_credentials.credential_version,
      lastValidatedAt: platform_access_token_credentials.last_validated_at,
    })
    .from(platform_integrations)
    .leftJoin(
      platform_access_token_credentials,
      and(
        eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id),
        eq(platform_access_token_credentials.owned_by_organization_id, organizationId),
        eq(platform_access_token_credentials.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_access_token_credentials.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        )
      )
    )
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_integrations.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        )
      )
    )
    .limit(1);
  return row ?? null;
}

type LoadedIntegration = NonNullable<Awaited<ReturnType<typeof loadIntegration>>>;

function belongsToWorkspace(fullName: string, workspaceSlug: string): boolean {
  const segments = fullName.split('/');
  return segments.length === 2 && segments[0] === workspaceSlug && segments[1].length > 0;
}

function repositoriesHaveUniqueIdentity(
  repositories: Array<{ id: string; fullName: string }>
): boolean {
  return (
    new Set(repositories.map(repository => repository.id)).size === repositories.length &&
    new Set(repositories.map(repository => repository.fullName)).size === repositories.length
  );
}

function parseCachedRepositories(
  repositoriesValue: unknown,
  repositoriesSyncedAt: string | null,
  workspace: WorkspaceIdentity
): AvailableRepositoryCache | null {
  if (repositoriesValue === null || repositoriesSyncedAt === null) return null;
  const repositories = z.array(CachedRepositorySchema).safeParse(repositoriesValue);
  if (!repositories.success) return null;

  const projected = repositories.data.map(repository => ({
    id: repository.id,
    workspaceUuid: workspace.uuid,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
  }));
  if (
    projected.some(repository => !belongsToWorkspace(repository.fullName, workspace.slug)) ||
    !repositoriesHaveUniqueIdentity(projected)
  ) {
    return null;
  }

  return {
    status: 'available',
    repositories: projected,
    syncedAt: new Date(repositoriesSyncedAt).toISOString(),
  };
}

function toIsoTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseIntegration(row: LoadedIntegration, organizationId: string) {
  const metadata = BitbucketWorkspaceAccessTokenMetadataSchema.safeParse(row.metadata);
  const workspaceUuid = z.uuid().safeParse(row.workspaceUuid);
  const workspaceSlug = WorkspaceSlugSchema.safeParse(row.workspaceSlug);
  const workspaceIdentity: WorkspaceIdentity | null =
    workspaceUuid.success && workspaceSlug.success
      ? { uuid: workspaceUuid.data, slug: workspaceSlug.data }
      : null;
  const workspace =
    metadata.success && workspaceIdentity
      ? { ...workspaceIdentity, displayName: metadata.data.displayName }
      : null;
  const cache = workspace
    ? parseCachedRepositories(row.repositories, row.repositoriesSyncedAt, workspace)
    : null;
  const credential =
    row.credentialId !== null &&
    row.credentialOrganizationId === organizationId &&
    row.credentialPlatform === BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM &&
    row.credentialIntegrationType === BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE &&
    row.credentialVersion !== null &&
    row.credentialVersion > 0
      ? { id: row.credentialId, version: row.credentialVersion }
      : null;
  const hasValidCredentialEvidence =
    credential !== null &&
    row.providerCredentialType === BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE &&
    row.providerScopes !== null &&
    hasRequiredBitbucketWorkspaceAccessTokenScopes(row.providerScopes) &&
    toIsoTimestamp(row.providerVerifiedAt) !== null &&
    toIsoTimestamp(row.lastValidatedAt) !== null;
  const usable =
    workspace !== null &&
    row.installationId === null &&
    hasValidCredentialEvidence &&
    row.integrationStatus === INTEGRATION_STATUS.ACTIVE &&
    row.authInvalidAt === null;
  const rotatable =
    row.integrationStatus === INTEGRATION_STATUS.ACTIVE &&
    row.installationId === null &&
    workspaceIdentity !== null &&
    credential !== null &&
    credential.version < 2_147_483_647;

  return {
    row,
    workspaceIdentity,
    workspace,
    cache,
    credential,
    state: usable ? ('usable' as const) : ('reconnect_required' as const),
    recoveryAction: usable
      ? null
      : rotatable
        ? ('replace_token' as const)
        : ('disconnect_and_connect' as const),
  };
}

async function loadParsedIntegration(organizationId: string) {
  const row = await loadIntegration(organizationId);
  return row ? parseIntegration(row, organizationId) : null;
}

function notConnectedStatus() {
  return {
    status: 'not_connected' as const,
    recoveryAction: null,
    method: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
    integrationId: null,
    integrationStatus: null,
    workspace: null,
    invalidatedAt: null,
    invalidationReason: null,
    lastValidatedAt: null,
    unexpectedScopes: [],
    repositoryCache: {
      status: 'uninitialized' as const,
      repositories: [],
      syncedAt: null,
    },
  };
}

export async function getBitbucketWorkspaceAccessTokenStatus(organizationId: string) {
  const canonicalOrganizationId = canonicalizeUuid(organizationId);
  if (!canonicalOrganizationId) return notConnectedStatus();
  const integration = await loadParsedIntegration(canonicalOrganizationId);
  if (!integration) return notConnectedStatus();

  const invalidationReason = InvalidationReasonSchema.safeParse(integration.row.authInvalidReason);
  const statusDetails = {
    method: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
    integrationId: integration.row.integrationId,
    integrationStatus: integration.row.integrationStatus,
    workspace: integration.workspace,
    invalidatedAt: toIsoTimestamp(integration.row.authInvalidAt),
    invalidationReason: invalidationReason.success ? invalidationReason.data : null,
    lastValidatedAt: toIsoTimestamp(integration.row.lastValidatedAt),
    unexpectedScopes: getUnexpectedBitbucketWorkspaceAccessTokenScopes(
      integration.row.providerScopes ?? []
    ),
    repositoryCache: integration.cache ?? {
      status: 'uninitialized' as const,
      repositories: [],
      syncedAt: null,
    },
  };
  if (integration.state === 'usable') {
    return { status: 'connected' as const, recoveryAction: null, ...statusDetails };
  }
  return {
    status: 'reconnect_required' as const,
    recoveryAction: integration.recoveryAction,
    ...statusDetails,
  };
}

export async function readCachedBitbucketWorkspaceAccessTokenRepositories({
  organizationId,
  expectedIntegrationId,
}: ReadCachedRepositoriesInput): Promise<BitbucketWorkspaceAccessTokenRepositoryListResult> {
  const canonicalOrganizationId = canonicalizeUuid(organizationId);
  const canonicalExpectedIntegrationId = expectedIntegrationId
    ? canonicalizeUuid(expectedIntegrationId)
    : undefined;
  if (!canonicalOrganizationId || (expectedIntegrationId && !canonicalExpectedIntegrationId)) {
    return { status: 'invalid_request' };
  }

  const integration = await loadParsedIntegration(canonicalOrganizationId);
  if (!integration) return { status: 'not_connected' };
  if (
    canonicalExpectedIntegrationId &&
    integration.row.integrationId !== canonicalExpectedIntegrationId
  ) {
    return { status: 'invalid_request' };
  }
  if (integration.state === 'reconnect_required') {
    return { status: 'reconnect_required' };
  }
  return integration.cache ?? { status: 'temporarily_unavailable' };
}

async function isObservedCredentialGenerationCurrent(
  tx: DrizzleTransaction,
  organizationId: string,
  observed: { integrationId: string; credentialId: string; credentialVersion: number }
): Promise<boolean> {
  const [current] = await tx
    .select({
      integrationId: platform_integrations.id,
      credentialId: platform_access_token_credentials.id,
      credentialVersion: platform_access_token_credentials.credential_version,
    })
    .from(platform_integrations)
    .innerJoin(
      platform_access_token_credentials,
      and(
        eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id),
        eq(platform_access_token_credentials.owned_by_organization_id, organizationId),
        eq(platform_access_token_credentials.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_access_token_credentials.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        )
      )
    )
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_integrations.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        )
      )
    );
  return (
    current?.integrationId === observed.integrationId &&
    current.credentialId === observed.credentialId &&
    current.credentialVersion === observed.credentialVersion
  );
}

export async function refreshBitbucketWorkspaceAccessTokenRepositories({
  organizationId,
  kiloUserId,
  expectedIntegrationId,
}: RefreshRepositoriesInput): Promise<BitbucketWorkspaceAccessTokenRepositoryListResult> {
  const canonicalOrganizationId = canonicalizeUuid(organizationId);
  const canonicalExpectedIntegrationId = canonicalizeUuid(expectedIntegrationId);
  if (!canonicalOrganizationId || !canonicalExpectedIntegrationId) {
    return { status: 'invalid_request' };
  }

  const integration = await loadParsedIntegration(canonicalOrganizationId);
  if (!integration) return { status: 'not_connected' };
  if (integration.row.integrationId !== canonicalExpectedIntegrationId) {
    return { status: 'invalid_request' };
  }
  if (
    integration.state === 'reconnect_required' ||
    !integration.workspaceIdentity ||
    !integration.credential
  ) {
    return { status: 'reconnect_required' };
  }
  const workspaceIdentity = integration.workspaceIdentity;
  const credential = integration.credential;

  const providerResult = await fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService(
    kiloUserId,
    canonicalOrganizationId
  );
  const stillCurrent = await db.transaction(async tx => {
    await lockBitbucketWorkspaceAccessTokenOrganization(tx, canonicalOrganizationId);
    return isObservedCredentialGenerationCurrent(tx, canonicalOrganizationId, {
      integrationId: integration.row.integrationId,
      credentialId: credential.id,
      credentialVersion: credential.version,
    });
  });
  if (!stillCurrent) {
    return readCachedBitbucketWorkspaceAccessTokenRepositories({
      organizationId: canonicalOrganizationId,
    });
  }
  if (providerResult.status !== 'available') return providerResult;
  if (
    providerResult.repositories.some(
      repository =>
        repository.workspaceUuid !== workspaceIdentity.uuid ||
        !belongsToWorkspace(repository.fullName, workspaceIdentity.slug)
    ) ||
    !repositoriesHaveUniqueIdentity(providerResult.repositories)
  ) {
    return { status: 'invalid_request' };
  }

  const repositories = providerResult.repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
    default_branch: repository.defaultBranch,
  }));
  const previousSyncedAtMs = integration.row.repositoriesSyncedAt
    ? new Date(integration.row.repositoriesSyncedAt).getTime()
    : 0;
  const syncedAt = new Date(
    Math.max(Date.now(), Number.isFinite(previousSyncedAtMs) ? previousSyncedAtMs + 1 : 0)
  ).toISOString();
  const previousCacheCondition = integration.row.repositoriesSyncedAt
    ? eq(platform_integrations.repositories_synced_at, integration.row.repositoriesSyncedAt)
    : isNull(platform_integrations.repositories_synced_at);

  let updated: boolean;
  try {
    updated = await db.transaction(async tx => {
      await lockBitbucketWorkspaceAccessTokenOrganization(tx, canonicalOrganizationId);
      await requireBitbucketWorkspaceAccessTokenOrganizationManager(
        tx,
        canonicalOrganizationId,
        kiloUserId
      );
      const currentCredential = tx
        .select({ id: platform_access_token_credentials.id })
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.id, credential.id),
            eq(
              platform_access_token_credentials.platform_integration_id,
              integration.row.integrationId
            ),
            eq(platform_access_token_credentials.owned_by_organization_id, canonicalOrganizationId),
            eq(platform_access_token_credentials.credential_version, credential.version)
          )
        );
      const [updatedRow] = await tx
        .update(platform_integrations)
        .set({
          repositories,
          repositories_synced_at: syncedAt,
          updated_at: syncedAt,
        })
        .where(
          and(
            eq(platform_integrations.id, integration.row.integrationId),
            eq(platform_integrations.owned_by_organization_id, canonicalOrganizationId),
            isNull(platform_integrations.owned_by_user_id),
            eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
            eq(
              platform_integrations.integration_type,
              BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
            ),
            eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
            isNull(platform_integrations.auth_invalid_at),
            isNull(platform_integrations.platform_installation_id),
            eq(platform_integrations.platform_account_id, workspaceIdentity.uuid),
            eq(platform_integrations.platform_account_login, workspaceIdentity.slug),
            previousCacheCondition,
            exists(currentCredential)
          )
        )
        .returning({ id: platform_integrations.id });
      return Boolean(updatedRow);
    });
  } catch (error) {
    if (error instanceof BitbucketWorkspaceAccessTokenOrganizationAuthorizationError) {
      throw new BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError();
    }
    throw error;
  }

  if (!updated) {
    return readCachedBitbucketWorkspaceAccessTokenRepositories({
      organizationId: canonicalOrganizationId,
    });
  }
  return { ...providerResult, syncedAt };
}
