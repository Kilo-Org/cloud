import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { platform_integrations, type User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';

const mockInstallations = new Map<string, unknown>();
const mockIdentityLinks = new Map<string, Set<string>>();
const mockGetInstallation = jest.fn(async (installationId: string) => {
  return mockInstallations.get(installationId) ?? null;
});
const mockSetInstallation = jest.fn(async (installationId: string, installation: unknown) => {
  mockInstallations.set(installationId, installation);
});
const mockDeleteInstallation = jest.fn(async (installationId: string) => {
  mockInstallations.delete(installationId);
});
const mockUnlinkTeamKiloUsers = jest.fn(
  async (_state: unknown, platform: string, teamId: string) => {
    mockIdentityLinks.delete(`${platform}:${teamId}`);
    return 0;
  }
);
const mockLinearOrganizationId = { current: 'linear-workspace' };
const mockSlackAccess = jest.fn();
const mockConsumeProviderOAuthAttempt = jest.fn(async (_input: unknown) => true);

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  LINEAR_CLIENT_ID: 'test-linear-client-id',
  LINEAR_CLIENT_SECRET: 'test-linear-client-secret',
  SLACK_CLIENT_ID: 'test-slack-client-id',
  SLACK_CLIENT_SECRET: 'test-slack-client-secret',
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@linear/sdk', () => ({
  LinearClient: jest.fn(() => ({
    get viewer() {
      return Promise.resolve({ id: 'linear-bot-user', displayName: 'Kilo' });
    },
    get organization() {
      return Promise.resolve({
        id: mockLinearOrganizationId.current,
        name: 'Victim Workspace',
        urlKey: 'victim',
      });
    },
  })),
}));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({ oauth: { v2: { access: mockSlackAccess } } })),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(() => ({
      getInstallation: (installationId: string) => mockGetInstallation(installationId),
      setInstallation: (installationId: string, installation: unknown) =>
        mockSetInstallation(installationId, installation),
      deleteInstallation: (installationId: string) => mockDeleteInstallation(installationId),
    })),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(async () => undefined),
  unlinkTeamKiloUsers: (state: unknown, platform: string, teamId: string) =>
    mockUnlinkTeamKiloUsers(state, platform, teamId),
}));
jest.mock('@/lib/bot/linear-link-state', () => ({
  verifyLinearBotLinkState: jest.fn(() => null),
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  getPlatformIntegrationById: jest.fn(),
  canKiloUserAccessPlatformIntegration: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: { require: jest.fn() },
}));
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  consumeProviderOAuthAttempt: (input: unknown) => mockConsumeProviderOAuthAttempt(input),
  cancelProviderOAuthAttempt: jest.fn(async () => true),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const createProviderState = (userId: string) =>
  createOAuthState(`user_${userId}`, userId, undefined, 'provider_install');

async function callCallback(platform: 'linear' | 'slack', query: string) {
  const { GET } = await import('./[platform]/callback/route');
  return GET(
    new NextRequest(`http://localhost:3000/api/integrations/${platform}/callback${query}`),
    {
      params: Promise.resolve({ platform }),
    }
  );
}

function redirectPath(response: Response) {
  const location = response.headers.get('location');
  const url = new URL(location ?? '');
  return `${url.pathname}${url.search}`;
}

async function seedIntegration(user: User, platform: 'linear' | 'slack', installationId: string) {
  const [row] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: user.id,
      owned_by_organization_id: null,
      platform,
      integration_type: 'oauth',
      platform_installation_id: installationId,
      platform_account_id: installationId,
      platform_account_login: 'Existing Workspace',
      scopes: [],
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: { bot_enabled: true },
      installed_at: '2026-01-01T00:00:00.000Z',
    })
    .returning();
  return row;
}

async function findIntegration(ownerUserId: string, platform: 'linear' | 'slack') {
  const [row] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_user_id, ownerUserId),
        eq(platform_integrations.platform, platform)
      )
    );
  return row ?? null;
}

const existingLinearInstallation = {
  accessToken: 'existing-linear-token',
  botUserId: 'linear-bot-user',
  expiresAt: null,
  organizationId: 'linear-workspace',
};
const existingSlackInstallation = {
  botToken: 'xoxb-existing-token',
  botUserId: 'U0EXISTING',
  teamName: 'Existing Team',
};

let owner: User;
let otherOwner: User;

beforeEach(() => {
  mockInstallations.clear();
  mockIdentityLinks.clear();
  jest.clearAllMocks();
  mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
  mockLinearOrganizationId.current = 'linear-workspace';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://api.linear.app/oauth/token') {
      return new Response(JSON.stringify({ access_token: 'lin-app-token', expires_in: 86_400 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected outbound request: ${url}`);
  }) as typeof fetch;

  mockSlackAccess.mockResolvedValue({
    ok: true,
    access_token: 'xoxb-new-token',
    bot_user_id: 'U0BOT',
    team: { id: 'T0TEAM', name: 'Acme Workspace' },
    is_enterprise_install: false,
  });

  mockedGetUserFromAuth.mockResolvedValue({
    user: { id: otherOwner.id },
    authFailedResponse: null,
  } as never);
});

beforeAll(async () => {
  owner = await insertTestUser({
    google_user_email: 'oauth-conflict-owner@example.com',
    google_user_name: 'OAuth Conflict Owner',
  });
  otherOwner = await insertTestUser({
    google_user_email: 'oauth-conflict-other@example.com',
    google_user_name: 'OAuth Conflict Other',
  });
});

afterEach(async () => {
  for (const user of [owner, otherOwner]) {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, user.id));
  }
});

describe('Linear install callback against the real integration row', () => {
  test('rejects a workspace held by another owner without changing its installation or links', async () => {
    const victimRow = await seedIntegration(owner, PLATFORM.LINEAR, 'linear-workspace');
    mockInstallations.set('linear-workspace', existingLinearInstallation);
    mockIdentityLinks.set('linear:linear-workspace', new Set(['linear-user-1']));

    const response = await callCallback(
      'linear',
      `?code=abc&state=${createProviderState(otherOwner.id)}`
    );

    expect(redirectPath(response)).toBe('/integrations/linear?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockInstallations.get('linear-workspace')).toBe(existingLinearInstallation);
    expect(mockIdentityLinks.get('linear:linear-workspace')).toEqual(new Set(['linear-user-1']));
    expect(mockUnlinkTeamKiloUsers).not.toHaveBeenCalled();

    const unchanged = await findIntegration(owner.id, PLATFORM.LINEAR);
    expect(unchanged).toMatchObject({
      id: victimRow.id,
      platform_installation_id: 'linear-workspace',
      platform_account_login: 'Existing Workspace',
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: { bot_enabled: true },
      updated_at: victimRow.updated_at,
    });
    expect(await findIntegration(otherOwner.id, PLATFORM.LINEAR)).toBeNull();
  });

  test('connects an unclaimed workspace and stores its installation and row', async () => {
    mockLinearOrganizationId.current = 'linear-workspace-new';

    const response = await callCallback(
      'linear',
      `?code=abc&state=${createProviderState(otherOwner.id)}`
    );

    expect(redirectPath(response)).toBe('/integrations/linear?success=installed');
    expect(mockInstallations.get('linear-workspace-new')).toMatchObject({
      accessToken: 'lin-app-token',
      botUserId: 'linear-bot-user',
      organizationId: 'linear-workspace-new',
    });

    const row = await findIntegration(otherOwner.id, PLATFORM.LINEAR);
    expect(row).toMatchObject({
      platform_installation_id: 'linear-workspace-new',
      platform_account_login: 'Victim Workspace',
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: expect.objectContaining({ bot_enabled: true, bot_user_id: 'linear-bot-user' }),
    });
  });
});

describe('Slack install callback against the real integration row', () => {
  test('rejects a workspace held by another owner without changing its installation or links', async () => {
    const victimRow = await seedIntegration(owner, PLATFORM.SLACK, 'T0TEAM');
    mockInstallations.set('T0TEAM', existingSlackInstallation);
    mockIdentityLinks.set('slack:T0TEAM', new Set(['slack-user-1']));

    const response = await callCallback(
      'slack',
      `?code=abc&state=${createProviderState(otherOwner.id)}`
    );

    expect(redirectPath(response)).toBe('/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockInstallations.get('T0TEAM')).toBe(existingSlackInstallation);
    expect(mockIdentityLinks.get('slack:T0TEAM')).toEqual(new Set(['slack-user-1']));

    const unchanged = await findIntegration(owner.id, PLATFORM.SLACK);
    expect(unchanged).toMatchObject({
      id: victimRow.id,
      platform_installation_id: 'T0TEAM',
      integration_status: INTEGRATION_STATUS.ACTIVE,
      updated_at: victimRow.updated_at,
    });
    expect(await findIntegration(otherOwner.id, PLATFORM.SLACK)).toBeNull();
  });

  test('connects an unclaimed workspace and stores its installation and row', async () => {
    mockSlackAccess.mockResolvedValue({
      ok: true,
      access_token: 'xoxb-new-token',
      bot_user_id: 'U0BOT',
      team: { id: 'T0NEWTEAM', name: 'New Workspace' },
      is_enterprise_install: false,
    });

    const response = await callCallback(
      'slack',
      `?code=abc&state=${createProviderState(otherOwner.id)}`
    );

    expect(redirectPath(response)).toBe('/integrations/slack?success=installed');
    expect(mockInstallations.get('T0NEWTEAM')).toMatchObject({
      botToken: 'xoxb-new-token',
      botUserId: 'U0BOT',
      teamName: 'New Workspace',
    });

    const row = await findIntegration(otherOwner.id, PLATFORM.SLACK);
    expect(row).toMatchObject({
      platform_installation_id: 'T0NEWTEAM',
      platform_account_login: 'New Workspace',
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata: expect.objectContaining({ bot_user_id: 'U0BOT' }),
    });
  });
});
