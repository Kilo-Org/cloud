import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { beginProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { SLACK_SCOPES } from '@/lib/integrations/slack-service';
import { handleSlackOAuthCallback } from './slack-callback';

const mockHandleOAuthCallback = jest.fn();
const mockSetInstallation = jest.fn();
const mockDeleteInstallation = jest.fn();
const mockRevokeToken = jest.fn();
const mockRevokedTokens: string[] = [];
const mockWriteSlackCredential = jest.fn();

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => {}),
    getAdapter: () => ({
      handleOAuthCallback: (...args: unknown[]) => mockHandleOAuthCallback(...args),
      setInstallation: (...args: unknown[]) => mockSetInstallation(...args),
      deleteInstallation: (...args: unknown[]) => mockDeleteInstallation(...args),
    }),
  },
}));
jest.mock('@slack/web-api', () => ({
  WebClient: function WebClient(this: unknown, token: string) {
    mockRevokedTokens.push(token);
    return { auth: { revoke: () => mockRevokeToken() } };
  },
}));
jest.mock('@/lib/integrations/platforms/slack/credential-store', () => ({
  writeSlackCredential: (...args: unknown[]) => mockWriteSlackCredential(...args),
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test-model'),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const OWNER_USER_ID = crypto.randomUUID();
const ACTING_USER_ID = crypto.randomUUID();
const TEAM_ID = 'T_DB_SHARED';
const TEAM_NAME = 'Shared DB Workspace';
const RECORDED_TOKEN = 'fixture-recorded-token';
const INCOMING_TOKEN = 'fixture-incoming-token';
const REINSTALL_TOKEN = 'fixture-reinstall-token';

function buildUser(id: string, name: string) {
  return {
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: name,
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_slack_${id}`,
  };
}

async function callCallback(ownerUserId: string) {
  const owner = `user_${ownerUserId}`;
  const state = createOAuthState(owner, ownerUserId, undefined, 'provider_install');
  await beginProviderOAuthAttempt({
    actorUserId: ownerUserId,
    owner: { type: 'user', id: ownerUserId },
    provider: 'slack',
    state,
    purpose: 'provider_install',
  });
  const request = new NextRequest(
    `http://localhost:3000/api/integrations/slack/callback?code=code-1&state=${encodeURIComponent(state)}`
  );
  return handleSlackOAuthCallback(request);
}

describe('Slack OAuth callback workspace binding', () => {
  beforeAll(async () => {
    await db
      .insert(kilocode_users)
      .values([
        buildUser(OWNER_USER_ID, 'Recorded Owner'),
        buildUser(ACTING_USER_ID, 'Second Installer'),
      ]);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRevokedTokens.length = 0;
    mockSetInstallation.mockResolvedValue(undefined);
    mockDeleteInstallation.mockResolvedValue(undefined);
    mockRevokeToken.mockResolvedValue({ ok: true });
    mockWriteSlackCredential.mockResolvedValue(undefined);
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, OWNER_USER_ID));
    await db.insert(platform_integrations).values({
      owned_by_user_id: OWNER_USER_ID,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: TEAM_ID,
      platform_account_id: TEAM_ID,
      platform_account_login: TEAM_NAME,
      scopes: SLACK_SCOPES,
      integration_status: 'active',
      metadata: { access_token: RECORDED_TOKEN, bot_user_id: 'U_RECORDED_OWNER' },
    });
  });

  afterAll(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, OWNER_USER_ID));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, ACTING_USER_ID));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, OWNER_USER_ID));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ACTING_USER_ID));
  });

  function recordInvocation(accessToken = INCOMING_TOKEN) {
    mockHandleOAuthCallback.mockResolvedValue({
      teamId: TEAM_ID,
      installation: {
        botToken: accessToken,
        botUserId: 'U_INCOMING',
        teamName: TEAM_NAME,
      },
    });
  }

  it("leaves the recorded owner's row and installation in place when another user installs the workspace", async () => {
    recordInvocation();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: ACTING_USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);

    const [before] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, OWNER_USER_ID));

    const response = await callCallback(ACTING_USER_ID);

    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.pathname}${location.search}`).toBe(
      '/integrations/slack?error=workspace_already_connected'
    );

    const [after] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, OWNER_USER_ID));
    expect(after).toEqual(before);
    expect(mockSetInstallation).toHaveBeenCalledWith(TEAM_ID, {
      botToken: RECORDED_TOKEN,
      botUserId: 'U_RECORDED_OWNER',
      teamName: TEAM_NAME,
    });
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockRevokedTokens).toEqual([INCOMING_TOKEN]);
    expect(mockWriteSlackCredential).not.toHaveBeenCalled();

    const actingIntegrations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, ACTING_USER_ID));
    expect(actingIntegrations).toEqual([]);
  });

  it('records a reinstall by the same user and leaves the installation untouched', async () => {
    recordInvocation(REINSTALL_TOKEN);
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: OWNER_USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);

    const response = await callCallback(OWNER_USER_ID);

    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.pathname}${location.search}`).toBe('/integrations/slack?success=installed');

    const [after] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, OWNER_USER_ID));
    expect(after.platform_installation_id).toBe(TEAM_ID);
    expect(after.metadata).toEqual(
      expect.objectContaining({
        access_token: REINSTALL_TOKEN,
        bot_user_id: 'U_INCOMING',
      })
    );
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockRevokedTokens).toEqual([]);
  });
});
