/* eslint-disable drizzle/enforce-delete-with-where */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type * as BitbucketRepositoryCacheModule from '@/lib/integrations/platforms/bitbucket/repository-cache';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

const mockScheduleBitbucketRepositoryCachePrime =
  jest.fn<
    (input: {
      owner: { type: 'user' | 'org'; id: string };
      kiloUserId: string;
      integrationId: string;
    }) => void
  >();

jest.mock('@/lib/integrations/platforms/bitbucket/repository-cache', () => ({
  ...jest.requireActual<typeof BitbucketRepositoryCacheModule>(
    '@/lib/integrations/platforms/bitbucket/repository-cache'
  ),
  scheduleBitbucketRepositoryCachePrime: mockScheduleBitbucketRepositoryCachePrime,
}));

type DirectBitbucketCaller = {
  bitbucket: {
    getInstallation(input?: { organizationId?: string }): Promise<unknown>;
    selectWorkspace(input: {
      organizationId?: string;
      workspaceUuid: string;
      workspaceSlug: string;
    }): Promise<unknown>;
    disconnect(input?: { organizationId?: string }): Promise<unknown>;
  };
};

let createCallerForUser: (userId: string) => Promise<DirectBitbucketCaller>;

async function insertPendingIntegration(organizationId: string, authorizedByUserId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      created_by_user_id: authorizedByUserId,
      platform: 'bitbucket',
      integration_type: 'oauth',
      scopes: ['account', 'repository', 'repository:write', 'webhook'],
      repository_access: 'all',
      integration_status: 'pending',
      metadata: {
        state: 'workspace_selection_required',
        availableWorkspaces: [
          {
            uuid: '123e4567-e89b-12d3-a456-426614174020',
            slug: 'acme',
            name: 'Acme',
          },
          {
            uuid: '123e4567-e89b-12d3-a456-426614174021',
            slug: 'example',
            name: 'Example',
          },
        ],
      },
    })
    .returning();
  if (!integration) throw new Error('Expected Bitbucket integration');
  await db.insert(platform_oauth_credentials).values({
    platform_integration_id: integration.id,
    platform: 'bitbucket',
    authorized_by_user_id: authorizedByUserId,
    provider_subject_id: '123e4567-e89b-12d3-a456-426614174010',
    provider_subject_login: 'bucket-admin',
    access_token_encrypted: 'access-envelope',
    access_token_expires_at: '2030-01-01T00:00:00.000Z',
    refresh_token_encrypted: 'refresh-envelope',
  });
  return integration;
}

describe('bitbucketRouter organization ownership', () => {
  let owner: User;
  let billingManager: User;
  let member: User;
  let organization: Organization;

  beforeAll(async () => {
    const [{ bitbucketRouter }, { createCallerFactory }, { findUserById }] = await Promise.all([
      import('./bitbucket-router'),
      import('@/lib/trpc/init'),
      import('@/lib/user'),
    ]);
    const createDirectCaller = createCallerFactory(bitbucketRouter);
    createCallerForUser = async userId => {
      const user = await findUserById(userId);
      if (!user) throw new Error(`Test user not found: ${userId}`);
      return { bitbucket: createDirectCaller({ user }) };
    };
    owner = await insertTestUser();
    billingManager = await insertTestUser();
    member = await insertTestUser();
    organization = await createTestOrganization('Bitbucket Router Org', owner.id, 0);
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
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_integrations);
  });

  afterAll(async () => {
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('lets members see pending status without exposing the authorizer or workspace candidates', async () => {
    await insertPendingIntegration(organization.id, owner.id);

    const ownerCaller = await createCallerForUser(owner.id);
    const memberCaller = await createCallerForUser(member.id);

    await expect(
      ownerCaller.bitbucket.getInstallation({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'workspace_selection_required',
      authorizingNickname: 'bucket-admin',
      availableWorkspaces: expect.arrayContaining([expect.objectContaining({ slug: 'acme' })]),
      canManage: true,
    });
    await expect(
      memberCaller.bitbucket.getInstallation({ organizationId: organization.id })
    ).resolves.toEqual({ status: 'workspace_selection_required', canManage: false });
  });

  it('rejects workspace selection by an ordinary member', async () => {
    await insertPendingIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.bitbucket.selectWorkspace({
        organizationId: organization.id,
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        workspaceSlug: 'acme',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('allows a billing manager to activate the organization workspace and primes its repository cache', async () => {
    const integration = await insertPendingIntegration(organization.id, owner.id);
    const caller = await createCallerForUser(billingManager.id);

    await expect(
      caller.bitbucket.selectWorkspace({
        organizationId: organization.id,
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        workspaceSlug: 'acme',
      })
    ).resolves.toMatchObject({ success: true, workspace: { slug: 'acme' } });
    await expect(
      caller.bitbucket.getInstallation({ organizationId: organization.id })
    ).resolves.toMatchObject({ status: 'connected', canManage: true });
    expect(mockScheduleBitbucketRepositoryCachePrime).toHaveBeenCalledWith({
      owner: { type: 'org', id: organization.id },
      kiloUserId: billingManager.id,
      integrationId: integration.id,
    });
  });

  it('rejects disconnect by an ordinary member and allows the owner', async () => {
    await insertPendingIntegration(organization.id, owner.id);
    const memberCaller = await createCallerForUser(member.id);
    const ownerCaller = await createCallerForUser(owner.id);

    await expect(
      memberCaller.bitbucket.disconnect({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      ownerCaller.bitbucket.disconnect({ organizationId: organization.id })
    ).resolves.toEqual({ success: true });
  });
});
