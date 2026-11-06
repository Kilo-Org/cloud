import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  provider_oauth_attempts,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { beginProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import {
  exchangeLinearOAuthCode,
  fetchLinearOAuthIdentity,
  getConflictingLinearInstallation,
  upsertLinearInstallation,
} from '@/lib/integrations/linear-service';
import { bot } from '@/lib/bot';
import { handleLinearOAuthCallback } from './linear-callback';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'linear-callback-role-matrix-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(async () => undefined),
  unlinkTeamKiloUsers: jest.fn(async () => 0),
}));
jest.mock('@/lib/bot/linear-link-state', () => ({
  verifyLinearBotLinkState: jest.fn(() => null),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: { require: jest.fn(() => ({ isEnabledForBot: jest.fn() })) },
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
}));
jest.mock('@/lib/integrations/linear-service', () => {
  const actual = jest.requireActual('@/lib/integrations/linear-service');
  return {
    ...actual,
    exchangeLinearOAuthCode: jest.fn(),
    fetchLinearOAuthIdentity: jest.fn(),
    getConflictingLinearInstallation: jest.fn(),
    revokeLinearToken: jest.fn(async () => true),
    upsertLinearInstallation: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeLinearOAuthCode = jest.mocked(exchangeLinearOAuthCode);
const mockedFetchLinearOAuthIdentity = jest.mocked(fetchLinearOAuthIdentity);
const mockedGetConflictingLinearInstallation = jest.mocked(getConflictingLinearInstallation);
const mockedUpsertLinearInstallation = jest.mocked(upsertLinearInstallation);
const mockedBotGetAdapter = jest.mocked(bot.getAdapter);

const WORKSPACE_ID = 'f1c9d0d8-2c3f-4b7e-9f61-0f5f0c2f7a10';
const ROLE_KEYS = ['owner', 'admin', 'billing_manager', 'member', 'non_member'] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

let organization: Organization;
let users: Record<RoleKey, User>;

const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');

async function completeOrgInstall(actor: User) {
  const state = createOAuthState(`org_${organization.id}`, actor.id, undefined, {
    provider: 'linear',
    purpose: 'provider_install',
  });
  await beginProviderOAuthAttempt({
    actorUserId: actor.id,
    owner: { type: 'org', id: organization.id },
    provider: 'linear',
    state,
    purpose: 'provider_install',
  });
  mockedGetUserFromAuth.mockResolvedValue({
    user: { id: actor.id },
    authFailedResponse: null,
  } as never);

  const response = await handleLinearOAuthCallback(
    new NextRequest(
      `http://localhost:3000/api/integrations/linear/callback?code=code-1&state=${encodeURIComponent(state)}`
    )
  );
  const [attempt] = await db
    .select({ status: provider_oauth_attempts.status })
    .from(provider_oauth_attempts)
    .where(eq(provider_oauth_attempts.state_hash, stateHash(state)));
  return { response, attempt };
}

function redirectLocation(response: Response): { pathname: string; error: string | null } {
  const url = new URL(response.headers.get('location') ?? '');
  return { pathname: url.pathname, error: url.searchParams.get('error') };
}

afterEach(async () => {
  const userIds = Object.values(users).map(user => user.id);
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, organization.id));
  await db.delete(organizations).where(eq(organizations.id, organization.id));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
});

beforeEach(async () => {
  jest.clearAllMocks();
  const owner = await insertTestUser();
  const admin = await insertTestUser();
  const billingManager = await insertTestUser();
  const member = await insertTestUser();
  const nonMember = await insertTestUser();

  organization = await createTestOrganization(
    `Linear install roles ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  await addUserToOrganization(organization.id, admin.id, 'admin');
  await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
  await addUserToOrganization(organization.id, member.id, 'member');

  users = { owner, admin, billing_manager: billingManager, member, non_member: nonMember };
  mockedExchangeLinearOAuthCode.mockResolvedValue({
    accessToken: 'lin_app_tok',
    refreshToken: null,
    expiresIn: null,
    scope: null,
  });
  mockedFetchLinearOAuthIdentity.mockResolvedValue({
    viewerId: 'linear-bot-user',
    viewerName: 'Kilo',
    organizationId: WORKSPACE_ID,
    organizationName: 'Acme Workspace',
  });
  mockedGetConflictingLinearInstallation.mockResolvedValue(null);
  mockedUpsertLinearInstallation.mockResolvedValue({} as never);
  mockedBotGetAdapter.mockReturnValue({
    getInstallation: jest.fn(async () => null),
    setInstallation: jest.fn(async () => undefined),
    deleteInstallation: jest.fn(async () => undefined),
  } as never);
});

describe('Linear organization install completion roles', () => {
  it('does not complete an organization install without the organization role', async () => {
    const { response, attempt } = await completeOrgInstall(users.member);

    expect(redirectLocation(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/linear`,
      error: 'permission_required',
    });
    expect(attempt?.status).toBe('pending');
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(mockedUpsertLinearInstallation).not.toHaveBeenCalled();
  });

  it('reports a missing organization membership with its own error code', async () => {
    const { response, attempt } = await completeOrgInstall(users.non_member);

    expect(redirectLocation(response)).toEqual({
      pathname: `/organizations/${organization.id}/integrations/linear`,
      error: 'organization_access_required',
    });
    expect(attempt?.status).toBe('pending');
    expect(mockedExchangeLinearOAuthCode).not.toHaveBeenCalled();
  });

  it.each(['billing_manager', 'admin', 'owner'] as const)(
    'completes and consumes the attempt for a %s',
    async role => {
      const { response, attempt } = await completeOrgInstall(users[role]);

      expect(redirectLocation(response)).toEqual({
        pathname: `/organizations/${organization.id}/integrations/linear`,
        error: null,
      });
      expect(attempt?.status).toBe('consumed');
      expect(mockedExchangeLinearOAuthCode).toHaveBeenCalledTimes(1);
      expect(mockedUpsertLinearInstallation).toHaveBeenCalledWith(
        expect.objectContaining({ owner: { type: 'org', id: organization.id } }),
        expect.anything(),
        expect.anything()
      );
    }
  );

  it('keeps a personal install available to a plain organization member', async () => {
    const actor = users.member;
    const state = createOAuthState(`user_${actor.id}`, actor.id, undefined, {
      provider: 'linear',
      purpose: 'provider_install',
    });
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner: { type: 'user', id: actor.id },
      provider: 'linear',
      state,
      purpose: 'provider_install',
    });
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: actor.id },
      authFailedResponse: null,
    } as never);

    const response = await handleLinearOAuthCallback(
      new NextRequest(
        `http://localhost:3000/api/integrations/linear/callback?code=code-1&state=${encodeURIComponent(state)}`
      )
    );

    expect(redirectLocation(response)).toEqual({ pathname: '/integrations/linear', error: null });
    const [attempt] = await db
      .select({ status: provider_oauth_attempts.status })
      .from(provider_oauth_attempts)
      .where(eq(provider_oauth_attempts.state_hash, stateHash(state)));
    expect(attempt?.status).toBe('consumed');
    expect(mockedUpsertLinearInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ owner: { type: 'user', id: actor.id } }),
      expect.anything(),
      expect.anything()
    );
  });
});
