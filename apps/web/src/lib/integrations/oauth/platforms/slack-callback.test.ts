process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockEnsureOrganizationAccess = jest.fn();
const mockConsumeProviderOAuthAttempt = jest.fn();
const mockCancelProviderOAuthAttempt = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockGetInstallationByTeamId = jest.fn();
const mockRevokeSlackToken = jest.fn();
const mockHandleOAuthCallback = jest.fn();
const mockSetInstallation = jest.fn();
const mockDeleteInstallation = jest.fn();
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: (...args: unknown[]) => mockEnsureOrganizationAccess(...args),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));
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
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  beginProviderOAuthAttempt: jest.fn(),
  cancelProviderOAuthAttempt: (...args: unknown[]) => mockCancelProviderOAuthAttempt(...args),
  consumeProviderOAuthAttempt: (...args: unknown[]) => mockConsumeProviderOAuthAttempt(...args),
}));
jest.mock('@/lib/integrations/slack-service', () => {
  class SlackWorkspaceAlreadyConnectedError extends Error {
    constructor(teamName: string) {
      super(`${teamName} is already connected to another Kilo account or organization.`);
      this.name = 'SlackWorkspaceAlreadyConnectedError';
    }
  }
  return {
    SlackWorkspaceAlreadyConnectedError,
    getInstallationByTeamId: (...args: unknown[]) => mockGetInstallationByTeamId(...args),
    revokeSlackToken: (...args: unknown[]) => mockRevokeSlackToken(...args),
    upsertSlackInstallation: (...args: unknown[]) => mockUpsertSlackInstallation(...args),
  };
});

import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { SlackWorkspaceAlreadyConnectedError } from '@/lib/integrations/slack-service';
import { handleSlackOAuthCallback } from './slack-callback';

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '7e3011af-e99d-444f-8171-54c2225b87dc';
const installation = { botToken: 'xoxb-token', botUserId: 'U_BOT', teamName: 'Kilo Team' };

const permissionDeniedError = new TRPCError({
  code: 'UNAUTHORIZED',
  message: 'You do not have the required organizational role to access this feature',
});

async function callCallback(
  owner: string,
  statePurpose: 'provider_install' | null = 'provider_install'
) {
  const state = createOAuthState(owner, USER_ID, undefined, statePurpose ?? undefined);
  const request = new NextRequest(
    `http://localhost:3000/api/integrations/slack/callback?code=code-1&state=${encodeURIComponent(state)}`
  );
  const response = await handleSlackOAuthCallback(request);
  return { response, state };
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('handleSlackOAuthCallback organization authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockUpsertSlackInstallation.mockResolvedValue({ id: 'integration-1' });
    mockHandleOAuthCallback.mockResolvedValue({ teamId: 'T123', installation });
  });

  it('refuses an organization completion by a plain member', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(permissionDeniedError);

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'permission_required'
    );
    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ORGANIZATION_MANAGE_ROLES
    );
    expect(mockUpsertSlackInstallation).not.toHaveBeenCalled();
    expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('refuses a member completion that carries no install purpose', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(permissionDeniedError);

    const { response, state } = await callCallback(`org_${ORGANIZATION_ID}`, null);

    expect(JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString())).not.toHaveProperty(
      'purpose'
    );
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'permission_required'
    );
    expect(mockUpsertSlackInstallation).not.toHaveBeenCalled();
    expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
  });

  it('completes an organization install for an admin and authorizes a workspace change', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('admin');

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe(
      '/organizations/' + ORGANIZATION_ID + '/integrations/slack'
    );
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith({
      owner: { type: 'org', id: ORGANIZATION_ID },
      teamId: 'T123',
      installation,
      allowWorkspaceRebind: true,
    });
  });

  it('keeps a same-workspace re-install working for an organization admin', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockHandleOAuthCallback.mockResolvedValue({ teamId: 'T123', installation });

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('success')).toBe(
      'installed'
    );
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'T123', allowWorkspaceRebind: true })
    );
  });

  it('does not require organization authority for a personal completion', async () => {
    const { response } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/integrations/slack');
    expect(mockEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      teamId: 'T123',
      installation,
      allowWorkspaceRebind: false,
    });
  });
});

describe('handleSlackOAuthCallback workspace ownership', () => {
  const TEAM_ID = 'T_SHARED';
  const TEAM_NAME = 'Shared Workspace';
  const STORED_TOKEN = 'bot-token-existing-owner';
  const REJECTED_TOKEN = 'bot-token-rejected-exchange';

  function buildStoredIntegration(overrides: Record<string, unknown> = {}) {
    return {
      id: 'integration-existing-owner',
      platform: 'slack',
      platform_installation_id: TEAM_ID,
      platform_account_id: TEAM_ID,
      platform_account_login: TEAM_NAME,
      integration_status: 'active',
      owned_by_user_id: 'other-owner',
      owned_by_organization_id: null,
      metadata: { access_token: STORED_TOKEN, bot_user_id: 'U_EXISTING_OWNER' },
      ...overrides,
    } as never;
  }

  function mockRejectedExchange(rejectedToken = REJECTED_TOKEN) {
    mockHandleOAuthCallback.mockResolvedValue({
      teamId: TEAM_ID,
      installation: {
        botToken: rejectedToken,
        botUserId: 'U_REJECTED_INSTALL',
        teamName: TEAM_NAME,
      },
    });
    mockUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetInstallation.mockResolvedValue(undefined);
    mockDeleteInstallation.mockResolvedValue(undefined);
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockCancelProviderOAuthAttempt.mockResolvedValue(true);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockRevokeSlackToken.mockResolvedValue(true);
    mockGetInstallationByTeamId.mockResolvedValue(null);
  });

  it("keeps the recorded owner's installation when another owner installs the workspace", async () => {
    mockRejectedExchange();
    mockGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockGetInstallationByTeamId).toHaveBeenCalledWith(TEAM_ID);
    expect(mockSetInstallation).toHaveBeenCalledTimes(1);
    expect(mockSetInstallation).toHaveBeenCalledWith(TEAM_ID, {
      botToken: STORED_TOKEN,
      botUserId: 'U_EXISTING_OWNER',
      teamName: TEAM_NAME,
    });
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockRevokeSlackToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('keeps the workspace token when an install returns the recorded token', async () => {
    mockRejectedExchange(STORED_TOKEN);
    mockGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).toHaveBeenCalledWith(TEAM_ID, {
      botToken: STORED_TOKEN,
      botUserId: 'U_EXISTING_OWNER',
      teamName: TEAM_NAME,
    });
    expect(mockRevokeSlackToken).not.toHaveBeenCalled();
  });

  it('removes the installation when the workspace has no recorded owner', async () => {
    mockRejectedExchange();

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
  });

  it('removes the installation when the recorded integration has no token', async () => {
    mockRejectedExchange();
    mockGetInstallationByTeamId.mockResolvedValue(
      buildStoredIntegration({ metadata: { bot_user_id: 'U_EXISTING_OWNER' } })
    );

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
  });

  it('revokes the incoming token when removing the installation fails', async () => {
    mockRejectedExchange();
    mockDeleteInstallation.mockRejectedValue(new Error('state unavailable'));

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('removes the installation when the recorded owner cannot be written', async () => {
    mockRejectedExchange();
    mockSetInstallation.mockRejectedValue(new Error('state unavailable'));
    mockGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('leaves a same-owner reinstall untouched', async () => {
    mockHandleOAuthCallback.mockResolvedValue({
      teamId: TEAM_ID,
      installation: { botToken: STORED_TOKEN, botUserId: 'U_EXISTING_OWNER', teamName: TEAM_NAME },
    });
    mockUpsertSlackInstallation.mockResolvedValue(buildStoredIntegration());

    const { response } = await callCallback(`user_${USER_ID}`);

    expectRedirectLocation(response, '/integrations/slack?success=installed');
    expect(mockUpsertSlackInstallation).toHaveBeenCalledTimes(1);
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockRevokeSlackToken).not.toHaveBeenCalled();
    expect(mockGetInstallationByTeamId).not.toHaveBeenCalled();
  });
});
