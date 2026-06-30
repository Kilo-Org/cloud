/* eslint-disable drizzle/enforce-delete-with-where */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { fetchBitbucketRepositoriesForOrganization as FetchForOrganization } from '@/lib/cloud-agent/bitbucket-integration-helpers';
import type { BitbucketRepositoryListResult } from './token-service-client';
import type * as TokenServiceClientModule from './token-service-client';
import type {
  getBitbucketWorkspaceAccessTokenStatus as GetStatus,
  readCachedBitbucketWorkspaceAccessTokenRepositories as ReadRepositories,
  refreshBitbucketWorkspaceAccessTokenRepositories as RefreshRepositories,
} from './workspace-access-token-repository-cache';

const mockFetchBitbucketRepositoriesFromTokenService =
  jest.fn<(kiloUserId: string, organizationId: string) => Promise<BitbucketRepositoryListResult>>();

jest.mock('./token-service-client', () => ({
  BitbucketRepositorySchema:
    jest.requireActual<typeof TokenServiceClientModule>('./token-service-client')
      .BitbucketRepositorySchema,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService:
    mockFetchBitbucketRepositoriesFromTokenService,
}));

const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';
const CACHED_AT = '2026-06-24T08:00:00.000Z';
const WINNER_CACHED_AT = '2026-06-24T09:00:00.000Z';
const CACHED_REPOSITORY = {
  id: REPOSITORY_UUID,
  name: 'API',
  full_name: 'acme/api',
  private: true,
  default_branch: 'main',
};
const REFRESHED_REPOSITORY = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceUuid: WORKSPACE_UUID,
  name: 'Web',
  fullName: 'acme/web',
  private: false,
};

let fetchBitbucketRepositoriesForOrganization: typeof FetchForOrganization;
let getBitbucketWorkspaceAccessTokenStatus: typeof GetStatus;
let readCachedBitbucketWorkspaceAccessTokenRepositories: typeof ReadRepositories;
let refreshBitbucketWorkspaceAccessTokenRepositories: typeof RefreshRepositories;

async function insertStaticIntegration(
  organizationId: string,
  actorUserId: string,
  cache: { repositories?: Array<typeof CACHED_REPOSITORY> | null; syncedAt?: string | null } = {}
) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      owned_by_user_id: null,
      created_by_user_id: actorUserId,
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      platform_account_id: WORKSPACE_UUID,
      platform_account_login: 'acme',
      platform_installation_id: null,
      repository_access: 'all',
      repositories: cache.repositories === undefined ? [CACHED_REPOSITORY] : cache.repositories,
      repositories_synced_at: cache.syncedAt === undefined ? CACHED_AT : cache.syncedAt,
      integration_status: 'active',
      metadata: { displayName: 'Acme Workspace' },
    })
    .returning();
  if (!integration) throw new Error('Expected static Bitbucket integration');

  await db.insert(platform_access_token_credentials).values({
    platform_integration_id: integration.id,
    owned_by_organization_id: organizationId,
    platform: 'bitbucket',
    integration_type: 'workspace_access_token',
    token_encrypted: 'ciphertext',
    expires_at: '2030-01-01T23:59:59.999Z',
    provider_credential_type: 'workspace_access_token',
    provider_scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    provider_verified_at: CACHED_AT,
    credential_version: 1,
    last_validated_at: CACHED_AT,
  });

  return integration;
}

async function replaceWithWinnerIntegration(
  organizationId: string,
  actorUserId: string,
  losingIntegrationId: string
) {
  const winnerIntegrationId = '55555555-5555-4555-8555-555555555555';
  await db.transaction(async tx => {
    await tx.delete(platform_integrations).where(eq(platform_integrations.id, losingIntegrationId));
    await tx.insert(platform_integrations).values({
      id: winnerIntegrationId,
      owned_by_organization_id: organizationId,
      owned_by_user_id: null,
      created_by_user_id: actorUserId,
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      platform_account_id: WORKSPACE_UUID,
      platform_account_login: 'acme',
      platform_installation_id: null,
      repository_access: 'all',
      repositories: [
        {
          id: REFRESHED_REPOSITORY.id,
          name: REFRESHED_REPOSITORY.name,
          full_name: REFRESHED_REPOSITORY.fullName,
          private: REFRESHED_REPOSITORY.private,
        },
      ],
      repositories_synced_at: WINNER_CACHED_AT,
      integration_status: 'active',
      metadata: { displayName: 'Acme Workspace' },
    });
    await tx.insert(platform_access_token_credentials).values({
      id: '66666666-6666-4666-8666-666666666666',
      platform_integration_id: winnerIntegrationId,
      owned_by_organization_id: organizationId,
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      token_encrypted: 'reconnected-ciphertext',
      expires_at: '2030-01-01T23:59:59.999Z',
      provider_credential_type: 'workspace_access_token',
      provider_scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      provider_verified_at: WINNER_CACHED_AT,
      credential_version: 1,
      last_validated_at: WINNER_CACHED_AT,
    });
  });
  return winnerIntegrationId;
}

describe('Bitbucket Workspace Access Token repository cache', () => {
  let user: User;
  let organization: Organization;

  beforeAll(async () => {
    ({
      getBitbucketWorkspaceAccessTokenStatus,
      readCachedBitbucketWorkspaceAccessTokenRepositories,
      refreshBitbucketWorkspaceAccessTokenRepositories,
    } = await import('./workspace-access-token-repository-cache'));
    ({ fetchBitbucketRepositoriesForOrganization } =
      await import('@/lib/cloud-agent/bitbucket-integration-helpers'));
    user = await insertTestUser();
    organization = await createTestOrganization('Static Bitbucket Cache Org', user.id, 0);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await db.delete(platform_access_token_credentials);
    await db.delete(platform_integrations);
  });

  afterAll(async () => {
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('returns an initialized organization cache without calling the token service', async () => {
    await insertStaticIntegration(organization.id, user.id);

    await expect(
      readCachedBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [
        {
          id: REPOSITORY_UUID,
          workspaceUuid: WORKSPACE_UUID,
          name: 'API',
          fullName: 'acme/api',
          private: true,
          defaultBranch: 'main',
        },
      ],
      syncedAt: CACHED_AT,
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();
  });

  it('force-refreshes an organization cache for a member repository listing', async () => {
    const member = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: member.id,
      role: 'member',
    });
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    await expect(
      fetchBitbucketRepositoriesForOrganization(organization.id, member.id, true)
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
      syncedAt: expect.any(String),
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).toHaveBeenCalledWith(
      member.id,
      organization.id
    );

    const [updated] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([
      {
        id: REFRESHED_REPOSITORY.id,
        name: REFRESHED_REPOSITORY.name,
        full_name: REFRESHED_REPOSITORY.fullName,
        private: REFRESHED_REPOSITORY.private,
      },
    ]);
    expect(updated?.syncedAt).toBeTruthy();
  });

  it('reads status with a canonicalized uppercase organization UUID', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);

    await expect(
      getBitbucketWorkspaceAccessTokenStatus(organization.id.toUpperCase())
    ).resolves.toMatchObject({
      status: 'connected',
      recoveryAction: null,
      integrationId: integration.id,
      workspace: { uuid: WORKSPACE_UUID, slug: 'acme' },
    });
  });

  it('reports permissions beyond the required Workspace Access Token scopes', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_scopes: [
          'account',
          'pullrequest',
          'repository',
          'repository:admin',
          'repository:write',
          'webhook',
        ],
      })
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      unexpectedScopes: ['repository:admin'],
    });
  });

  it('treats stronger pull request scopes as satisfying Workspace Access Token status', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_scopes: ['account', 'pullrequest:write', 'webhook'],
      })
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      unexpectedScopes: [],
    });
  });

  it('requires disconnect and reconnect when the credential is missing', async () => {
    await insertStaticIntegration(organization.id, user.id);
    await db.delete(platform_access_token_credentials);

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'reconnect_required',
      recoveryAction: 'disconnect_and_connect',
    });
  });

  it.each([
    ['malformed workspace', { platform_account_id: 'not-a-workspace-uuid' }],
    ['inactive parent', { integration_status: 'inactive' }],
  ] as const)('requires disconnect and reconnect for an %s', async (_label, update) => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_integrations)
      .set(update)
      .where(eq(platform_integrations.id, integration.id));

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'reconnect_required',
      recoveryAction: 'disconnect_and_connect',
    });
  });

  it('allows token replacement for ordinary invalidation', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: '2026-06-24T09:00:00.000Z',
        auth_invalid_reason: 'provider_rejected',
      })
      .where(eq(platform_integrations.id, integration.id));

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'reconnect_required',
      recoveryAction: 'replace_token',
    });
  });

  it('ignores a legacy recorded expiry when provider evidence is valid', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_access_token_credentials)
      .set({ expires_at: '2020-01-01T23:59:59.999Z' })
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      recoveryAction: null,
    });
  });

  it('canonicalizes uppercase owner and integration UUIDs before a forced refresh', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id.toUpperCase(),
        kiloUserId: user.id,
        expectedIntegrationId: integration.id.toUpperCase(),
      })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).toHaveBeenCalledWith(
      user.id,
      organization.id
    );

    const [updated] = await db
      .select({ repositories: platform_integrations.repositories })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([
      {
        id: REFRESHED_REPOSITORY.id,
        name: REFRESHED_REPOSITORY.name,
        full_name: REFRESHED_REPOSITORY.fullName,
        private: REFRESHED_REPOSITORY.private,
      },
    ]);
  });

  it('does not initialize an absent member cache through the token service', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id, {
      repositories: null,
      syncedAt: null,
    });
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    await expect(
      fetchBitbucketRepositoriesForOrganization(organization.id, user.id)
    ).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged).toEqual({ repositories: null, syncedAt: null });
  });

  it('does not replace a malformed member cache through the token service', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id, {
      repositories: null,
      syncedAt: CACHED_AT,
    });
    const malformedRepositories = [{ id: 'not-a-repository-uuid' }];
    await db
      .update(platform_integrations)
      .set({ repositories: malformedRepositories as never })
      .where(eq(platform_integrations.id, integration.id));
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
    });

    await expect(
      fetchBitbucketRepositoriesForOrganization(organization.id, user.id)
    ).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual(malformedRepositories);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(CACHED_AT);
  });

  it('initializes an absent cache through an explicit forced refresh', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id, {
      repositories: null,
      syncedAt: null,
    });
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [
        {
          id: REPOSITORY_UUID,
          workspaceUuid: WORKSPACE_UUID,
          name: 'API',
          fullName: 'acme/api',
          private: true,
          defaultBranch: 'main',
        },
      ],
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [expect.objectContaining({ id: REPOSITORY_UUID })],
      syncedAt: expect.any(String),
    });
    expect(mockFetchBitbucketRepositoriesFromTokenService).toHaveBeenCalledWith(
      user.id,
      organization.id
    );

    const [updated] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(updated?.syncedAt).toBeTruthy();
  });

  it('returns a current malformed available result as invalid_request without mutation', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'available',
      repositories: [{ ...REFRESHED_REPOSITORY, workspaceUuid: REPOSITORY_UUID }],
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({ status: 'invalid_request' });

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(CACHED_AT);
  });

  it.each([
    'insufficient_permissions',
    'reconnect_required',
    'temporarily_unavailable',
    'invalid_request',
  ] as const)('propagates %s and preserves the last successful cache', async status => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({ status });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({ status });

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(CACHED_AT);
  });

  it('preserves a newer same-generation cache when an older refresh completes later', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await db
        .update(platform_integrations)
        .set({
          repositories: [
            {
              id: REFRESHED_REPOSITORY.id,
              name: REFRESHED_REPOSITORY.name,
              full_name: REFRESHED_REPOSITORY.fullName,
              private: REFRESHED_REPOSITORY.private,
            },
          ],
          repositories_synced_at: WINNER_CACHED_AT,
        })
        .where(eq(platform_integrations.id, integration.id));
      return {
        status: 'available',
        repositories: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            workspaceUuid: WORKSPACE_UUID,
            name: 'Older',
            fullName: 'acme/older',
            private: true,
          },
        ],
      };
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
      syncedAt: WINNER_CACHED_AT,
    });

    const [winner] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(winner?.repositories).toEqual([
      {
        id: REFRESHED_REPOSITORY.id,
        name: REFRESHED_REPOSITORY.name,
        full_name: REFRESHED_REPOSITORY.fullName,
        private: REFRESHED_REPOSITORY.private,
      },
    ]);
    expect(new Date(winner?.syncedAt ?? '').toISOString()).toBe(WINNER_CACHED_AT);
  });

  it.each(['reconnect_required', 'insufficient_permissions', 'temporarily_unavailable'] as const)(
    'ignores stale %s after a newer credential generation wins',
    async status => {
      const integration = await insertStaticIntegration(organization.id, user.id);
      mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
        await db.transaction(async tx => {
          await tx
            .update(platform_access_token_credentials)
            .set({ credential_version: 2, token_encrypted: 'winner-ciphertext' })
            .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
          await tx
            .update(platform_integrations)
            .set({
              repositories: [
                {
                  id: REFRESHED_REPOSITORY.id,
                  name: REFRESHED_REPOSITORY.name,
                  full_name: REFRESHED_REPOSITORY.fullName,
                  private: REFRESHED_REPOSITORY.private,
                },
              ],
              repositories_synced_at: WINNER_CACHED_AT,
            })
            .where(eq(platform_integrations.id, integration.id));
        });
        return { status };
      });

      await expect(
        refreshBitbucketWorkspaceAccessTokenRepositories({
          organizationId: organization.id,
          kiloUserId: user.id,
          expectedIntegrationId: integration.id,
        })
      ).resolves.toEqual({
        status: 'available',
        repositories: [REFRESHED_REPOSITORY],
        syncedAt: WINNER_CACHED_AT,
      });

      const [winner] = await db
        .select({
          repositories: platform_integrations.repositories,
          syncedAt: platform_integrations.repositories_synced_at,
        })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(winner?.repositories).toEqual([
        {
          id: REFRESHED_REPOSITORY.id,
          name: REFRESHED_REPOSITORY.name,
          full_name: REFRESHED_REPOSITORY.fullName,
          private: REFRESHED_REPOSITORY.private,
        },
      ]);
      expect(new Date(winner?.syncedAt ?? '').toISOString()).toBe(WINNER_CACHED_AT);
    }
  );

  it.each([
    ['provider failure', { status: 'reconnect_required' } as const],
    [
      'malformed available result',
      {
        status: 'available' as const,
        repositories: [{ ...REFRESHED_REPOSITORY, workspaceUuid: REPOSITORY_UUID }],
      },
    ],
    [
      'valid available result',
      { status: 'available' as const, repositories: [REFRESHED_REPOSITORY] },
    ],
  ])('returns the reconnected winner cache after a stale %s', async (_label, providerResult) => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await replaceWithWinnerIntegration(organization.id, user.id, integration.id);
      return providerResult;
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [REFRESHED_REPOSITORY],
      syncedAt: WINNER_CACHED_AT,
    });
  });

  it('keeps the successful cache visible in status after refresh failure', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockResolvedValue({
      status: 'temporarily_unavailable',
    });

    await refreshBitbucketWorkspaceAccessTokenRepositories({
      organizationId: organization.id,
      kiloUserId: user.id,
      expectedIntegrationId: integration.id,
    });

    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      repositoryCache: {
        status: 'available',
        repositories: [expect.objectContaining({ id: REPOSITORY_UUID })],
        syncedAt: CACHED_AT,
      },
    });
  });

  it('fails closed when the joined credential evidence no longer satisfies the profile', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    await db
      .update(platform_access_token_credentials)
      .set({ provider_scopes: ['account'] })
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));

    await expect(
      readCachedBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
      })
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(mockFetchBitbucketRepositoriesFromTokenService).not.toHaveBeenCalled();
  });

  it('rejects a forced refresh when management authority is lost during provider I/O', async () => {
    const manager = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: manager.id,
      role: 'billing_manager',
    });
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.kilo_user_id, manager.id));
      return { status: 'available', repositories: [REFRESHED_REPOSITORY] };
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: manager.id,
        expectedIntegrationId: integration.id,
      })
    ).rejects.toMatchObject({
      name: 'BitbucketWorkspaceAccessTokenRepositoryCacheAuthorizationError',
      message: 'The current user cannot refresh this organization integration',
    });

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(CACHED_AT);
  });

  it('does not replace the cache after the credential generation changes', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await db
        .update(platform_access_token_credentials)
        .set({ credential_version: 2, token_encrypted: 'rotated-ciphertext' })
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
      return { status: 'available', repositories: [REFRESHED_REPOSITORY] };
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({
      status: 'available',
      repositories: [
        {
          id: REPOSITORY_UUID,
          workspaceUuid: WORKSPACE_UUID,
          name: 'API',
          fullName: 'acme/api',
          private: true,
          defaultBranch: 'main',
        },
      ],
      syncedAt: CACHED_AT,
    });

    const [unchanged] = await db
      .select({ repositories: platform_integrations.repositories })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([CACHED_REPOSITORY]);
  });

  it('never clears parent invalidation while a refresh is in flight', async () => {
    const integration = await insertStaticIntegration(organization.id, user.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await db
        .update(platform_integrations)
        .set({
          auth_invalid_at: '2026-06-24T09:00:00.000Z',
          auth_invalid_reason: 'provider_rejected',
        })
        .where(eq(platform_integrations.id, integration.id));
      return { status: 'available', repositories: [REFRESHED_REPOSITORY] };
    });

    await expect(
      refreshBitbucketWorkspaceAccessTokenRepositories({
        organizationId: organization.id,
        kiloUserId: user.id,
        expectedIntegrationId: integration.id,
      })
    ).resolves.toEqual({ status: 'reconnect_required' });

    const [invalidated] = await db
      .select({
        repositories: platform_integrations.repositories,
        invalidAt: platform_integrations.auth_invalid_at,
        invalidReason: platform_integrations.auth_invalid_reason,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(invalidated?.repositories).toEqual([CACHED_REPOSITORY]);
    expect(new Date(invalidated?.invalidAt ?? '').toISOString()).toBe('2026-06-24T09:00:00.000Z');
    expect(invalidated?.invalidReason).toBe('provider_rejected');
  });
});
