import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { connectWithPAT } from '@/lib/integrations/gitlab-service';
import {
  buildGitLabOAuthUrl,
  calculateTokenExpiry,
  exchangeGitLabOAuthCode,
  fetchGitLabProjects,
  fetchGitLabUser,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { storeGitLabOAuthIntegration } from '@/lib/integrations/platforms/gitlab/oauth-integration-writer';
import { createGitLabOAuthState } from '@/lib/integrations/platforms/gitlab/oauth-state';
import {
  handleGitLabOAuthConnect,
  handleGitLabOAuthConnectPost,
} from '@/lib/integrations/oauth/platforms/gitlab-connect';
import { handleGitLabOAuthCallback } from '@/lib/integrations/oauth/platforms/gitlab-callback';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import { platform_integrations, type Organization, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/integrations/gitlab-service', () => ({
  ...jest.requireActual('@/lib/integrations/gitlab-service'),
  connectWithPAT: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual('@/lib/integrations/platforms/gitlab/adapter'),
  buildGitLabOAuthUrl: jest.fn(),
  exchangeGitLabOAuthCode: jest.fn(),
  fetchGitLabUser: jest.fn(),
  fetchGitLabProjects: jest.fn(),
  calculateTokenExpiry: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/oauth-credentials', () => ({
  storeGitLabOAuthCredentials: jest.fn(),
  getGitLabOAuthCredentials: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/oauth-integration-writer', () => ({
  storeGitLabOAuthIntegration: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedConnectWithPAT = jest.mocked(connectWithPAT);
const mockedBuildGitLabOAuthUrl = jest.mocked(buildGitLabOAuthUrl);
const mockedExchangeGitLabOAuthCode = jest.mocked(exchangeGitLabOAuthCode);
const mockedFetchGitLabUser = jest.mocked(fetchGitLabUser);
const mockedFetchGitLabProjects = jest.mocked(fetchGitLabProjects);
const mockedCalculateTokenExpiry = jest.mocked(calculateTokenExpiry);
const mockedStoreGitLabOAuthIntegration = jest.mocked(storeGitLabOAuthIntegration);

const ROLE_KEYS = ['owner', 'admin', 'member', 'billing_manager', 'non_member'] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

type Gate = 'member' | 'billing';

let organization: Organization;
let users: Record<RoleKey, User>;
let callers: Record<RoleKey, Awaited<ReturnType<typeof createCallerForUser>>>;

beforeAll(async () => {
  const owner = await insertTestUser();
  const admin = await insertTestUser();
  const member = await insertTestUser();
  const billingManager = await insertTestUser();
  const nonMember = await insertTestUser();

  // require_seats=false grants the trial bypass that the billing mutation
  // procedures need after their access check passes.
  organization = await createTestOrganization(
    `Security matrix ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  await addUserToOrganization(organization.id, admin.id, 'admin');
  await addUserToOrganization(organization.id, member.id, 'member');
  await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');

  users = { owner, admin, member, billing_manager: billingManager, non_member: nonMember };
  callers = {
    owner: await createCallerForUser(owner.id),
    admin: await createCallerForUser(admin.id),
    member: await createCallerForUser(member.id),
    billing_manager: await createCallerForUser(billingManager.id),
    non_member: await createCallerForUser(nonMember.id),
  };
});

function makeRequest(pathWithQuery: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirect(response: Response, expectedPathWithQuery: string): void {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

async function seedGitLabIntegration(): Promise<void> {
  await db.insert(platform_integrations).values({
    owned_by_organization_id: organization.id,
    platform: 'gitlab',
    integration_type: 'oauth',
    platform_installation_id: crypto.randomUUID(),
    integration_status: 'active',
    repository_access: 'all',
  });
}

// ---------------------------------------------------------------------------
// Role matrix: every organization-security-agent-router procedure × five roles
// ---------------------------------------------------------------------------

const memberProcedures: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'trackUiInteraction', input: { interaction: 'findings_filtered' } },
  { name: 'getPermissionStatus', input: {} },
  { name: 'getConfig', input: {} },
  { name: 'getRepositories', input: {} },
  { name: 'listFindings', input: {} },
  { name: 'getFinding', input: { id: crypto.randomUUID() } },
  { name: 'getStats', input: {} },
  { name: 'getDashboardStats', input: {} },
  { name: 'getLastSyncTime', input: {} },
  { name: 'triggerSync', input: {} },
  { name: 'startAnalysis', input: { findingId: crypto.randomUUID() } },
  { name: 'startRemediation', input: { findingId: crypto.randomUUID() } },
  { name: 'retryRemediation', input: { findingId: crypto.randomUUID() } },
  { name: 'cancelRemediation', input: { attemptId: crypto.randomUUID() } },
  { name: 'getAnalysis', input: { findingId: crypto.randomUUID() } },
  { name: 'getCommandStatus', input: { commandId: crypto.randomUUID() } },
  { name: 'getCommandStatuses', input: { commandIds: [crypto.randomUUID()] } },
  { name: 'listActiveCommands', input: {} },
  { name: 'getOrphanedRepositories', input: {} },
  { name: 'getAutoDismissEligible', input: {} },
];

const billingProcedures: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'saveConfig', input: { expectedRevision: null } },
  { name: 'setEnabled', input: { isEnabled: false } },
  { name: 'dismissFinding', input: { findingId: crypto.randomUUID(), reason: 'not_used' } },
  { name: 'deleteFindingsByRepository', input: { repoFullName: 'acme/api' } },
  { name: 'autoDismissEligible', input: {} },
  { name: 'getAuditReport', input: {} },
];

function expectsDeny(gate: Gate, roleKey: RoleKey): boolean {
  if (roleKey === 'non_member') return true;
  return gate === 'billing' && !(ORGANIZATION_BILLING_ROLES as readonly string[]).includes(roleKey);
}

async function expectGateAllows(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string } | null)?.code).not.toBe('UNAUTHORIZED');
  }
}

describe('organization security agent router role matrix', () => {
  it.each([
    ...memberProcedures.map(p => ({ ...p, gate: 'member' as const })),
    ...billingProcedures.map(p => ({ ...p, gate: 'billing' as const })),
  ])('$name ($gate gate) allows and denies the five roles', async ({ name, gate, input }) => {
    for (const roleKey of ROLE_KEYS) {
      const securityAgent = callers[roleKey].organizations.securityAgent as unknown as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      const promise = securityAgent[name]({ organizationId: organization.id, ...input });

      if (expectsDeny(gate, roleKey)) {
        await expect(promise).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      } else {
        await expectGateAllows(promise);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// connectWithPAT: rejects roles outside ORGANIZATION_BILLING_ROLES
// ---------------------------------------------------------------------------

describe('gitlabRouter.connectWithPAT role gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedConnectWithPAT.mockResolvedValue({
      success: true,
      integration: {
        id: crypto.randomUUID(),
        accountLogin: 'gitlab-user',
        accountId: '42',
        instanceUrl: 'https://gitlab.com',
      },
    });
  });

  it.each([
    ['owner', false],
    ['admin', false],
    ['billing_manager', false],
    ['member', true],
    ['non_member', true],
  ] as const)('role %s is %s', async (roleKey, shouldDeny) => {
    const promise = callers[roleKey].gitlab.connectWithPAT({
      token: 'glpat-test-token',
      instanceUrl: 'https://gitlab.com',
      organizationId: organization.id,
    });

    if (shouldDeny) {
      await expect(promise).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockedConnectWithPAT).not.toHaveBeenCalled();
    } else {
      await expect(promise).resolves.toMatchObject({ success: true });
      expect(mockedConnectWithPAT).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// GitLab OAuth replacement gate (start + callback)
// ---------------------------------------------------------------------------

describe('GitLab OAuth connect replacement gate', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    mockedGetUserFromAuth.mockResolvedValue({ user: users.member, authFailedResponse: null });
    mockedBuildGitLabOAuthUrl.mockReturnValue('https://gitlab.com/oauth/authorize?state=signed');
  });

  it('denies a member when the org already has a GitLab integration', async () => {
    await seedGitLabIntegration();

    const response = await handleGitLabOAuthConnect(
      makeRequest(`/api/integrations/gitlab/connect?organizationId=${organization.id}`)
    );

    expectRedirect(
      response,
      `/organizations/${organization.id}/integrations/gitlab?error=permission_required`
    );
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  it('allows a billing role to replace an existing GitLab integration', async () => {
    await seedGitLabIntegration();
    mockedGetUserFromAuth.mockResolvedValue({ user: users.owner, authFailedResponse: null });

    const response = await handleGitLabOAuthConnect(
      makeRequest(`/api/integrations/gitlab/connect?organizationId=${organization.id}`)
    );

    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/oauth/authorize?state=signed'
    );
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledTimes(1);
  });

  it('allows a member for a first-time connect', async () => {
    const response = await handleGitLabOAuthConnect(
      makeRequest(`/api/integrations/gitlab/connect?organizationId=${organization.id}`)
    );

    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/oauth/authorize?state=signed'
    );
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledTimes(1);
  });

  it('denies a member on the POST path with a permission error and non-5xx status', async () => {
    await seedGitLabIntegration();

    const response = await handleGitLabOAuthConnectPost(
      new NextRequest('http://localhost:3000/api/integrations/gitlab/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: organization.id }),
      })
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('permission_required');
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  it('redirects a non-member to organization_access_required', async () => {
    mockedGetUserFromAuth.mockResolvedValue({ user: users.non_member, authFailedResponse: null });

    const response = await handleGitLabOAuthConnect(
      makeRequest(`/api/integrations/gitlab/connect?organizationId=${organization.id}`)
    );

    expectRedirect(
      response,
      `/organizations/${organization.id}/integrations/gitlab?error=organization_access_required`
    );
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });
});

describe('GitLab OAuth callback replacement gate', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    mockedGetUserFromAuth.mockResolvedValue({ user: users.member, authFailedResponse: null });
  });

  function makeOrgState(userId: string = users.member.id): string {
    return createGitLabOAuthState({ owner: { type: 'org', id: organization.id } }, userId);
  }

  function mockSuccessfulGitLabOAuthExchange(): void {
    mockedExchangeGitLabOAuthCode.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 7200,
      created_at: 1234567890,
      scope: 'api read_user',
    });
    mockedFetchGitLabUser.mockResolvedValue({
      id: 42,
      username: 'gitlab-user',
      name: 'GitLab User',
      email: 'user@example.com',
      avatar_url: 'https://example.com/avatar.png',
      web_url: 'https://gitlab.com/gitlab-user',
    });
    mockedFetchGitLabProjects.mockResolvedValue([]);
    mockedCalculateTokenExpiry.mockReturnValue('2026-01-01T00:00:00.000Z');
    mockedStoreGitLabOAuthIntegration.mockResolvedValue({
      integrationId: crypto.randomUUID(),
      instanceChanged: false,
    });
  }

  it('denies a member when the org already has a GitLab integration', async () => {
    await seedGitLabIntegration();

    const state = makeOrgState();
    const response = await handleGitLabOAuthCallback(
      makeRequest(`/api/integrations/gitlab/callback?code=abc&state=${encodeURIComponent(state)}`)
    );

    expectRedirect(
      response,
      `/organizations/${organization.id}/integrations/gitlab?error=permission_required`
    );
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });

  it('allows a member for a first-time connect', async () => {
    mockSuccessfulGitLabOAuthExchange();

    const state = makeOrgState();
    const response = await handleGitLabOAuthCallback(
      makeRequest(`/api/integrations/gitlab/callback?code=abc&state=${encodeURIComponent(state)}`)
    );

    expectRedirect(
      response,
      `/organizations/${organization.id}/integrations/gitlab?success=connected`
    );
    expect(mockedExchangeGitLabOAuthCode).toHaveBeenCalledTimes(1);
  });

  it('allows a billing role to replace an existing GitLab integration', async () => {
    await seedGitLabIntegration();
    mockedGetUserFromAuth.mockResolvedValue({ user: users.owner, authFailedResponse: null });
    mockSuccessfulGitLabOAuthExchange();

    const state = makeOrgState(users.owner.id);
    const response = await handleGitLabOAuthCallback(
      makeRequest(`/api/integrations/gitlab/callback?code=abc&state=${encodeURIComponent(state)}`)
    );

    expectRedirect(
      response,
      `/organizations/${organization.id}/integrations/gitlab?success=connected`
    );
    expect(mockedExchangeGitLabOAuthCode).toHaveBeenCalledTimes(1);
  });
});
