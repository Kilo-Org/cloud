/* eslint-disable drizzle/enforce-delete-with-where */
import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  admin_action_audit_logs,
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organizations,
  platform_integrations,
  platform_oauth_credentials,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  exchangeBitbucketOAuthCode,
  fetchBitbucketUser,
  fetchBitbucketWorkspaces,
} from '@/lib/integrations/platforms/bitbucket/adapter';
import { scheduleBitbucketRepositoryCachePrime } from '@/lib/integrations/platforms/bitbucket/repository-cache';
import { handleBitbucketOAuthCallback } from './bitbucket-callback';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const mockBitbucketCredentialEncryptionConfig = {
  keyId: 'bitbucket-credential-key-v1',
  publicKey: Buffer.from(testKeyPair.publicKey).toString('base64'),
};

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'bitbucket-callback-test-secret',
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return mockBitbucketCredentialEncryptionConfig.keyId;
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockBitbucketCredentialEncryptionConfig.publicKey;
  },
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/bitbucket/adapter', () => {
  const actual = jest.requireActual('@/lib/integrations/platforms/bitbucket/adapter');
  return {
    ...actual,
    exchangeBitbucketOAuthCode: jest.fn(),
    fetchBitbucketUser: jest.fn(),
    fetchBitbucketWorkspaces: jest.fn(),
  };
});

jest.mock('@/lib/integrations/platforms/bitbucket/repository-cache', () => ({
  scheduleBitbucketRepositoryCachePrime: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeBitbucketOAuthCode = jest.mocked(exchangeBitbucketOAuthCode);
const mockedFetchBitbucketUser = jest.mocked(fetchBitbucketUser);
const mockedFetchBitbucketWorkspaces = jest.mocked(fetchBitbucketWorkspaces);
const mockedScheduleBitbucketRepositoryCachePrime = jest.mocked(
  scheduleBitbucketRepositoryCachePrime
);

let organization: Organization;
let owner: User;
let adminWithoutRole: User;
let adminWithOwnerRole: User;
let nonMember: User;

function connectAs(actor: User, ownerKind: 'org' | 'user'): Promise<Response> {
  const state = createOAuthState(
    ownerKind === 'org' ? `org_${organization.id}` : `user_${actor.id}`,
    actor.id,
    undefined,
    { provider: 'bitbucket' }
  );
  mockedGetUserFromAuth.mockResolvedValue({ user: actor, authFailedResponse: null });
  return handleBitbucketOAuthCallback(
    new NextRequest(
      `http://localhost:3000/api/integrations/bitbucket/callback?code=code-1&state=${encodeURIComponent(state)}`
    )
  );
}

function redirectStatus(response: Response): {
  pathname: string;
  success: string | null;
  error: string | null;
} {
  const url = new URL(response.headers.get('location') ?? '');
  return {
    pathname: url.pathname,
    success: url.searchParams.get('success'),
    error: url.searchParams.get('error'),
  };
}

async function organizationAuditRows() {
  return db
    .select()
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, organization.id));
}

async function adminAuditRows(actorId: string) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.actor_id, actorId));
}

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.SUPPORT_ACCESS_ENABLED = 'false';

  owner = await insertTestUser();
  adminWithoutRole = await insertTestUser({ is_admin: true });
  adminWithOwnerRole = await insertTestUser({ is_admin: true });
  nonMember = await insertTestUser();

  organization = await createTestOrganization(
    `Bitbucket OAuth connect ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  await db.insert(organization_memberships).values({
    organization_id: organization.id,
    kilo_user_id: adminWithOwnerRole.id,
    role: 'owner',
  });

  mockedExchangeBitbucketOAuthCode.mockResolvedValue({
    accessToken: 'bitbucket-access-token',
    refreshToken: 'bitbucket-refresh-token',
    tokenType: 'bearer',
    expiresIn: 3600,
    scopes: ['account', 'pullrequest', 'repository:write', 'webhook'],
  });
  mockedFetchBitbucketUser.mockResolvedValue({
    uuid: '{bitbucket-user-uuid}',
    nickname: 'octobucket',
    displayName: 'Octo Bucket',
  });
  mockedFetchBitbucketWorkspaces.mockResolvedValue([
    { uuid: '{workspace-uuid}', slug: 'kilo-workspace', name: 'Kilo Workspace' },
  ]);
});

afterEach(async () => {
  delete process.env.SUPPORT_ACCESS_ENABLED;
  await db
    .delete(admin_action_audit_logs)
    .where(
      inArray(admin_action_audit_logs.actor_id, [
        owner.id,
        adminWithoutRole.id,
        adminWithOwnerRole.id,
        nonMember.id,
      ])
    );
  await db
    .delete(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, organization.id));
  await db.delete(platform_oauth_credentials);
  await db.delete(platform_integrations);
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, organization.id));
  await db.delete(organizations).where(eq(organizations.id, organization.id));
  await db
    .delete(kilocode_users)
    .where(
      inArray(kilocode_users.id, [
        owner.id,
        adminWithoutRole.id,
        adminWithOwnerRole.id,
        nonMember.id,
      ])
    );
});

describe('Bitbucket OAuth callback organization connect records', () => {
  it('records the organization connect and one admin row for an admin without an organization role', async () => {
    const response = await connectAs(adminWithoutRole, 'org');

    expect(redirectStatus(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/bitbucket`,
      success: 'connected',
      error: null,
    });

    const [integration] = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    if (!integration) throw new Error('Expected the organization integration');

    const audits = await organizationAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'organization.settings.change',
      actor_id: adminWithoutRole.id,
      organization_id: organization.id,
    });

    const adminAudits = await adminAuditRows(adminWithoutRole.id);
    expect(adminAudits).toHaveLength(1);
    expect(adminAudits[0]).toMatchObject({
      action: 'organization.bitbucket.update',
      target_type: 'organization',
      target_id: organization.id,
      message: 'Bitbucket: OAuth connection created',
      metadata: {
        operation: 'oauth_connect',
        integrationId: integration.id,
        heldRoles: [],
      },
    });
    expect(mockedScheduleBitbucketRepositoryCachePrime).toHaveBeenCalledTimes(1);
  });

  it('records the organization connect for the owner and no admin row', async () => {
    const response = await connectAs(owner, 'org');

    expect(redirectStatus(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/bitbucket`,
      success: 'connected',
      error: null,
    });

    await expect(organizationAuditRows()).resolves.toHaveLength(1);
    await expect(adminAuditRows(owner.id)).resolves.toEqual([]);
  });

  it('records no admin row when the admin holds the organization role it already had', async () => {
    const response = await connectAs(adminWithOwnerRole, 'org');

    expect(redirectStatus(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/bitbucket`,
      success: 'connected',
      error: null,
    });

    await expect(organizationAuditRows()).resolves.toHaveLength(1);
    await expect(adminAuditRows(adminWithOwnerRole.id)).resolves.toEqual([]);
  });

  it('leaves no organization records when a non-member is refused', async () => {
    const response = await connectAs(nonMember, 'org');

    expect(redirectStatus(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/bitbucket`,
      success: null,
      error: 'unauthorized',
    });

    expect(mockedExchangeBitbucketOAuthCode).not.toHaveBeenCalled();
    await expect(organizationAuditRows()).resolves.toEqual([]);
    await expect(adminAuditRows(nonMember.id)).resolves.toEqual([]);
    await expect(db.select().from(platform_integrations)).resolves.toEqual([]);
  });

  it('leaves organization records alone for a personal connect', async () => {
    const response = await connectAs(owner, 'user');

    expect(redirectStatus(response)).toEqual({
      pathname: '/integrations/bitbucket',
      success: 'connected',
      error: null,
    });

    await expect(organizationAuditRows()).resolves.toEqual([]);
    await expect(adminAuditRows(owner.id)).resolves.toEqual([]);
  });
});
