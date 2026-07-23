/* eslint-disable drizzle/enforce-delete-with-where */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import type {
  BitbucketWorkspaceAccessTokenMutationResult,
  ConnectBitbucketWorkspaceAccessTokenInput,
  DisconnectBitbucketWorkspaceAccessTokenInput,
  RotateBitbucketWorkspaceAccessTokenInput,
} from '@/lib/integrations/platforms/bitbucket/workspace-access-token-credentials';
import type { createCallerForUser as CreateCallerForUser } from '@/routers/test-utils';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { BitbucketRepositoryListResult } from '@/lib/integrations/platforms/bitbucket/token-service-client';
import type * as TokenServiceClientModule from '@/lib/integrations/platforms/bitbucket/token-service-client';
import type * as BitbucketRepositoryCacheModule from '@/lib/integrations/platforms/bitbucket/repository-cache';
import {
  createCodeReview,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
} from '@/lib/code-reviews/db/code-reviews';

const mockFetchBitbucketRepositoriesFromTokenService =
  jest.fn<(kiloUserId: string, organizationId: string) => Promise<BitbucketRepositoryListResult>>();
const mockDeleteBitbucketWorkspaceWebhooksFromTokenService =
  jest.fn<(input: unknown) => Promise<unknown>>();
const mockScheduleBitbucketRepositoryCachePrime =
  jest.fn<
    (input: {
      owner: { type: 'user' | 'org'; id: string };
      kiloUserId: string;
      integrationId: string;
    }) => void
  >();

jest.mock('@/lib/integrations/platforms/bitbucket/token-service-client', () => ({
  BitbucketRepositorySchema: jest.requireActual<typeof TokenServiceClientModule>(
    '@/lib/integrations/platforms/bitbucket/token-service-client'
  ).BitbucketRepositorySchema,
  deleteBitbucketWorkspaceWebhooksFromTokenService:
    mockDeleteBitbucketWorkspaceWebhooksFromTokenService,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService:
    mockFetchBitbucketRepositoriesFromTokenService,
}));

jest.mock('@/lib/integrations/platforms/bitbucket/repository-cache', () => ({
  ...jest.requireActual<typeof BitbucketRepositoryCacheModule>(
    '@/lib/integrations/platforms/bitbucket/repository-cache'
  ),
  scheduleBitbucketRepositoryCachePrime: mockScheduleBitbucketRepositoryCachePrime,
}));

const mockConnect =
  jest.fn<
    (
      input: ConnectBitbucketWorkspaceAccessTokenInput
    ) => Promise<BitbucketWorkspaceAccessTokenMutationResult>
  >();
const mockDisconnect =
  jest.fn<
    (input: DisconnectBitbucketWorkspaceAccessTokenInput) => Promise<{ integrationId: string }>
  >();
const mockRotate =
  jest.fn<
    (
      input: RotateBitbucketWorkspaceAccessTokenInput
    ) => Promise<BitbucketWorkspaceAccessTokenMutationResult>
  >();

jest.mock('@/lib/integrations/platforms/bitbucket/workspace-access-token-credentials', () => ({
  connectBitbucketWorkspaceAccessToken: mockConnect,
  disconnectBitbucketWorkspaceAccessToken: mockDisconnect,
  rotateBitbucketWorkspaceAccessToken: mockRotate,
  BitbucketWorkspaceAccessTokenCredentialError: class extends Error {},
}));

const mockCancelReview = jest.fn<(reviewId: string, reason: string, attemptId?: string) => void>();

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: mockCancelReview,
  },
}));

let createCallerForUser: typeof CreateCallerForUser;

const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';
const VALIDATED_AT = '2026-06-24T08:00:00.000Z';

async function insertStaticIntegration(organizationId: string, actorUserId: string) {
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
      repositories: [
        {
          id: REPOSITORY_UUID,
          name: 'API',
          full_name: 'acme/api',
          private: true,
          default_branch: 'main',
        },
      ],
      repositories_synced_at: VALIDATED_AT,
      integration_status: 'active',
      metadata: { displayName: 'Acme Workspace' },
    })
    .returning();
  if (!integration) throw new Error('Expected static Bitbucket integration');

  await db.insert(platform_access_token_credentials).values({
    platform_integration_id: integration.id,
    token_encrypted: 'secret-ciphertext-must-not-be-returned',
    expires_at: null,
    provider_credential_type: 'workspace_access_token',
    provider_scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    provider_verified_at: VALIDATED_AT,
    credential_version: 1,
    last_validated_at: VALIDATED_AT,
  });

  return integration;
}

async function insertPendingOAuthIntegration(organizationId: string, actorUserId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      owned_by_user_id: null,
      created_by_user_id: actorUserId,
      platform: 'bitbucket',
      integration_type: 'oauth',
      scopes: ['account', 'email', 'repository', 'repository:write', 'webhook'],
      repository_access: 'all',
      integration_status: 'pending',
      metadata: {
        state: 'workspace_selection_required',
        availableWorkspaces: [
          {
            uuid: WORKSPACE_UUID,
            slug: 'acme',
            name: 'Acme Workspace',
          },
          {
            uuid: '33333333-3333-4333-8333-333333333333',
            slug: 'example',
            name: 'Example Workspace',
          },
        ],
      },
    })
    .returning();
  if (!integration) throw new Error('Expected pending Bitbucket OAuth integration');

  await db.insert(platform_oauth_credentials).values({
    platform_integration_id: integration.id,
    authorized_by_user_id: actorUserId,
    provider_subject_id: '44444444-4444-4444-8444-444444444444',
    provider_subject_login: 'bucket-admin',
    access_token_encrypted: 'access-envelope',
    access_token_expires_at: '2030-01-01T00:00:00.000Z',
    refresh_token_encrypted: 'refresh-envelope',
  });

  return integration;
}

async function insertActiveOAuthIntegration(organizationId: string, actorUserId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      owned_by_user_id: null,
      created_by_user_id: actorUserId,
      platform: 'bitbucket',
      integration_type: 'oauth',
      platform_installation_id: WORKSPACE_UUID,
      platform_account_id: WORKSPACE_UUID,
      platform_account_login: 'acme',
      scopes: ['account', 'email', 'repository', 'repository:write', 'webhook'],
      repository_access: 'all',
      repositories: [
        {
          id: REPOSITORY_UUID,
          name: 'API',
          full_name: 'acme/api',
          private: true,
          default_branch: 'main',
        },
      ],
      repositories_synced_at: VALIDATED_AT,
      integration_status: 'active',
      metadata: {
        state: 'active',
        workspace: { uuid: WORKSPACE_UUID, slug: 'acme', name: 'Acme Workspace' },
      },
    })
    .returning();
  if (!integration) throw new Error('Expected active Bitbucket OAuth integration');

  await db.insert(platform_oauth_credentials).values({
    platform_integration_id: integration.id,
    authorized_by_user_id: actorUserId,
    provider_subject_id: '44444444-4444-4444-8444-444444444444',
    provider_subject_login: 'bucket-admin',
    access_token_encrypted: 'access-envelope',
    access_token_expires_at: '2030-01-01T00:00:00.000Z',
    refresh_token_encrypted: 'refresh-envelope',
  });

  return integration;
}

describe('organization Bitbucket router', () => {
  let owner: User;
  let billingManager: User;
  let member: User;
  let organization: Organization;

  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
    owner = await insertTestUser();
    billingManager = await insertTestUser();
    member = await insertTestUser();
    organization = await createTestOrganization('Organization Bitbucket Router', owner.id, 0);
    await db.insert(organization_memberships).values([
      {
        organization_id: organization.id,
        kilo_user_id: billingManager.id,
        role: 'billing_manager',
      },
      { organization_id: organization.id, kilo_user_id: member.id, role: 'member' },
    ]);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await db.delete(cloud_agent_code_review_attempts);
    await db.delete(cloud_agent_code_reviews);
    await db.delete(agent_configs);
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_access_token_credentials);
    await db.delete(platform_integrations);
  });

  afterAll(async () => {
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('returns a sanitized initialized status to an ordinary member', async () => {
    const integration = await insertStaticIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(member.id);

    const result = await caller.organizations.bitbucket.getStatus({
      organizationId: organization.id,
    });

    expect(result).toEqual({
      status: 'connected',
      recoveryAction: null,
      method: 'workspace_access_token',
      integrationId: integration.id,
      integrationStatus: 'active',
      workspace: {
        uuid: WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      invalidatedAt: null,
      invalidationReason: null,
      lastValidatedAt: VALIDATED_AT,
      unexpectedScopes: [],
      repositoryCache: {
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
        syncedAt: VALIDATED_AT,
      },
      canManage: false,
    });
    expect(JSON.stringify(result)).not.toContain('ciphertext');
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('authorization');
  });

  it('preserves the last successful cache in an invalidated status projection', async () => {
    const integration = await insertStaticIntegration(organization.id, owner.id);
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: '2026-06-24T09:00:00.000Z',
        auth_invalid_reason: 'provider_rejected',
      })
      .where(eq(platform_integrations.id, integration.id));
    const caller = await createCallerForUser(member.id);

    const result = await caller.organizations.bitbucket.getStatus({
      organizationId: organization.id,
    });

    expect(result).toMatchObject({
      status: 'reconnect_required',
      recoveryAction: 'replace_token',
      invalidatedAt: '2026-06-24T09:00:00.000Z',
      invalidationReason: 'provider_rejected',
      repositoryCache: {
        status: 'available',
        repositories: [expect.objectContaining({ id: REPOSITORY_UUID })],
        syncedAt: VALIDATED_AT,
      },
      canManage: false,
    });
  });

  it('returns no recovery action when the organization is not connected', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'not_connected',
      recoveryAction: null,
      canManage: false,
    });
  });

  it('returns OAuth workspace selection details only to organization managers', async () => {
    const integration = await insertPendingOAuthIntegration(organization.id, owner.id);
    const ownerCaller = await createCallerForUser(owner.id);
    const memberCaller = await createCallerForUser(member.id);

    await expect(
      ownerCaller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'workspace_selection_required',
      recoveryAction: null,
      method: 'oauth',
      integrationId: integration.id,
      authorizingNickname: 'bucket-admin',
      availableWorkspaces: expect.arrayContaining([expect.objectContaining({ slug: 'acme' })]),
      canManage: true,
    });
    await expect(
      memberCaller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'workspace_selection_required',
      method: 'oauth',
      authorizingNickname: null,
      availableWorkspaces: [],
      canManage: false,
    });
  });

  it('lets a billing manager select the OAuth workspace and primes the repository cache', async () => {
    const integration = await insertPendingOAuthIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(billingManager.id);

    await expect(
      caller.organizations.bitbucket.selectWorkspace({
        organizationId: organization.id,
        workspaceUuid: WORKSPACE_UUID,
        workspaceSlug: 'acme',
      })
    ).resolves.toMatchObject({ success: true, workspace: { slug: 'acme' } });
    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'connected',
      method: 'oauth',
      workspace: { slug: 'acme', displayName: 'Acme Workspace' },
      canManage: true,
    });
    expect(mockScheduleBitbucketRepositoryCachePrime).toHaveBeenCalledWith({
      owner: { type: 'org', id: organization.id },
      kiloUserId: billingManager.id,
      integrationId: integration.id,
    });
  });

  it('returns OAuth repository cache and disconnects OAuth integrations by id', async () => {
    const integration = await insertActiveOAuthIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'connected',
      method: 'oauth',
      repositoryCache: {
        status: 'available',
        repositories: [expect.objectContaining({ fullName: 'acme/api' })],
        syncedAt: VALIDATED_AT,
      },
      canManage: true,
    });
    await expect(
      caller.organizations.bitbucket.disconnect({
        organizationId: organization.id,
        integrationId: integration.id,
      })
    ).resolves.toEqual({ integrationId: integration.id });
  });

  it('requires disconnect and reconnect when the credential is missing', async () => {
    await insertStaticIntegration(organization.id, owner.id);
    await db.delete(platform_access_token_credentials);
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'reconnect_required',
      recoveryAction: 'disconnect_and_connect',
      canManage: false,
    });
  });

  it('disables Bitbucket Code Reviewer before disconnecting a Workspace Access Token', async () => {
    const integration = await insertStaticIntegration(organization.id, owner.id);
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'bitbucket',
      config: {
        review_style: 'balanced',
        focus_areas: [],
        model_slug: 'test-model',
        repository_selection_mode: 'selected',
        selected_repository_ids: [REPOSITORY_UUID],
      },
      is_enabled: true,
      created_by: owner.id,
    });
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organization.id, userId: owner.id },
      platform: 'bitbucket',
      platformIntegrationId: integration.id,
      repoFullName: 'acme/api',
      prNumber: 42,
      prUrl: 'https://bitbucket.org/acme/api/pull-requests/42',
      prTitle: 'Disconnect cleanup',
      prAuthor: 'Ada Reviewer',
      baseRef: 'main',
      headRef: 'feature/disconnect-cleanup',
      headSha: 'a'.repeat(40),
    });
    await updateCodeReviewStatus(reviewId, 'running', {
      sessionId: 'agent-bitbucket-disconnect',
      cliSessionId: 'ses_bitbucket_disconnect',
    });
    const attempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: 'agent-bitbucket-disconnect',
      cliSessionId: 'ses_bitbucket_disconnect',
    });
    mockDisconnect.mockImplementationOnce(async () => {
      const [config] = await db
        .select({ isEnabled: agent_configs.is_enabled })
        .from(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, organization.id));
      const [review] = await db
        .select({ status: cloud_agent_code_reviews.status })
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, reviewId));

      expect(config?.isEnabled).toBe(false);
      expect(review?.status).toBe('cancelled');
      return { integrationId: integration.id };
    });
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.bitbucket.disconnect({
        organizationId: organization.id,
        integrationId: integration.id,
      })
    ).resolves.toEqual({ integrationId: integration.id });

    expect(mockCancelReview).toHaveBeenCalledWith(
      reviewId,
      'Bitbucket Code Reviewer disabled',
      attempt.id
    );
    expect(mockDeleteBitbucketWorkspaceWebhooksFromTokenService).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: owner.id,
        organizationId: organization.id,
        workspace: {
          integrationId: integration.id,
          workspaceUuid: WORKSPACE_UUID,
          workspaceSlug: 'acme',
        },
      })
    );
    expect(mockDisconnect).toHaveBeenCalledWith({
      organizationId: organization.id,
      actorUserId: owner.id,
      integrationId: integration.id,
    });
  });

  it('rejects every integration mutation for an ordinary member', async () => {
    const integration = await insertStaticIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.organizations.bitbucket.connect({
        organizationId: organization.id,
        accessToken: 'ATCT-member-secret',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.organizations.bitbucket.replaceToken({
        organizationId: organization.id,
        integrationId: integration.id,
        accessToken: 'ATCT-member-secret',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.organizations.bitbucket.refreshRepositories({
        organizationId: organization.id,
        integrationId: integration.id,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.organizations.bitbucket.disconnect({
        organizationId: organization.id,
        integrationId: integration.id,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.organizations.bitbucket.selectWorkspace({
        organizationId: organization.id,
        workspaceUuid: WORKSPACE_UUID,
        workspaceSlug: 'acme',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockRotate).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('returns sanitized authorization loss when a manager is demoted during refresh', async () => {
    const refreshManager = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: refreshManager.id,
      role: 'billing_manager',
    });
    const integration = await insertStaticIntegration(organization.id, owner.id);
    mockFetchBitbucketRepositoriesFromTokenService.mockImplementation(async () => {
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.kilo_user_id, refreshManager.id));
      return {
        status: 'available',
        repositories: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            workspaceUuid: WORKSPACE_UUID,
            name: 'Web',
            fullName: 'acme/web',
            private: false,
          },
        ],
      };
    });
    const caller = await createCallerForUser(refreshManager.id);

    await expect(
      caller.organizations.bitbucket.refreshRepositories({
        organizationId: organization.id,
        integrationId: integration.id,
      })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'The current user cannot refresh this organization integration',
    });

    const [unchanged] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged?.repositories).toEqual([
      {
        id: REPOSITORY_UUID,
        name: 'API',
        full_name: 'acme/api',
        private: true,
        default_branch: 'main',
      },
    ]);
    expect(new Date(unchanged?.syncedAt ?? '').toISOString()).toBe(VALIDATED_AT);
  });

  it('normalizes a billing manager Workspace Access Token before connecting', async () => {
    mockConnect.mockResolvedValue({
      integrationId: '33333333-3333-4333-8333-333333333333',
      workspace: {
        uuid: WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      credentialVersion: 1,
      repositoryCount: 1,
      validatedAt: VALIDATED_AT,
      unexpectedScopes: [],
    });
    const caller = await createCallerForUser(billingManager.id);

    await caller.organizations.bitbucket.connect({
      organizationId: organization.id,
      accessToken: '  ATCT-manager-secret\n',
    });

    expect(mockConnect).toHaveBeenCalledWith({
      organizationId: organization.id,
      actorUserId: billingManager.id,
      accessToken: 'ATCT-manager-secret',
    });
  });
});
