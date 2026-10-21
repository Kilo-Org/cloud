process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { GET as slackCallbackRoute } from '@/app/api/integrations/[platform]/callback/route';
import { bot } from '@/lib/bot';
import {
  getInstallationByTeamId,
  revokeSlackToken,
  SlackWorkspaceAlreadyConnectedError,
  upsertSlackInstallation,
} from '@/lib/integrations/slack-service';

const mockHandleOAuthCallback = jest.fn();
const mockSetInstallation = jest.fn(async (_teamId: string, _installation: unknown) => undefined);
const mockDeleteInstallation = jest.fn(async (_teamId: string) => undefined);
const mockConsumeProviderOAuthAttempt = jest.fn(async () => true);
const mockCancelProviderOAuthAttempt = jest.fn(async () => true);
const mockCaptureException = jest.fn();

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/integrations/slack-service', () => {
  class MockSlackWorkspaceAlreadyConnectedError extends Error {
    constructor(teamName: string) {
      super(`${teamName} is already connected to another Kilo account or organization.`);
      this.name = 'SlackWorkspaceAlreadyConnectedError';
    }
  }

  return {
    SlackWorkspaceAlreadyConnectedError: MockSlackWorkspaceAlreadyConnectedError,
    getInstallationByTeamId: jest.fn(),
    revokeSlackToken: jest.fn(async () => true),
    upsertSlackInstallation: jest.fn(),
  };
});
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  consumeProviderOAuthAttempt: () => mockConsumeProviderOAuthAttempt(),
  cancelProviderOAuthAttempt: () => mockCancelProviderOAuthAttempt(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBotGetAdapter = jest.mocked(bot.getAdapter);
const mockedUpsertSlackInstallation = jest.mocked(upsertSlackInstallation);
const mockedGetInstallationByTeamId = jest.mocked(getInstallationByTeamId);
const mockedRevokeSlackToken = jest.mocked(revokeSlackToken);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const TEAM_ID = 'T_SHARED';
const TEAM_NAME = 'Shared Workspace';
const STORED_TOKEN = 'bot-token-existing-owner';
const REJECTED_TOKEN = 'bot-token-rejected-exchange';

const createProviderState = () =>
  createOAuthState(`user_${USER_ID}`, USER_ID, undefined, 'provider_install');

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function callSlackCallback(request: NextRequest) {
  return slackCallbackRoute(request, { params: Promise.resolve({ platform: 'slack' }) });
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

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

function mockAdapter(rejectedToken = REJECTED_TOKEN) {
  mockHandleOAuthCallback.mockResolvedValue({
    teamId: TEAM_ID,
    installation: {
      botToken: rejectedToken,
      botUserId: 'U_REJECTED_INSTALL',
      teamName: TEAM_NAME,
    },
  });
  mockedBotGetAdapter.mockReturnValue({
    handleOAuthCallback: mockHandleOAuthCallback,
    setInstallation: mockSetInstallation,
    deleteInstallation: mockDeleteInstallation,
  } as never);
}

describe('GET /api/integrations/slack/callback workspace ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetInstallation.mockResolvedValue(undefined);
    mockDeleteInstallation.mockResolvedValue(undefined);
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockCancelProviderOAuthAttempt.mockResolvedValue(true);
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedRevokeSlackToken.mockResolvedValue(true);
    mockedGetInstallationByTeamId.mockResolvedValue(null);
  });

  test("keeps the recorded owner's installation when another owner installs the workspace", async () => {
    mockAdapter();
    mockedGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockedGetInstallationByTeamId).toHaveBeenCalledWith(TEAM_ID);
    expect(mockSetInstallation).toHaveBeenCalledTimes(1);
    expect(mockSetInstallation).toHaveBeenCalledWith(TEAM_ID, {
      botToken: STORED_TOKEN,
      botUserId: 'U_EXISTING_OWNER',
      teamName: TEAM_NAME,
    });
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockedRevokeSlackToken).toHaveBeenCalledTimes(1);
    expect(mockedRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
  });

  test('keeps the workspace token when an install returns the recorded token', async () => {
    mockAdapter(STORED_TOKEN);
    mockedGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).toHaveBeenCalledWith(TEAM_ID, {
      botToken: STORED_TOKEN,
      botUserId: 'U_EXISTING_OWNER',
      teamName: TEAM_NAME,
    });
    expect(mockedRevokeSlackToken).not.toHaveBeenCalled();
  });

  test('removes the installation when the workspace has no recorded owner', async () => {
    mockAdapter();
    mockedGetInstallationByTeamId.mockResolvedValue(null);
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockedRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
  });

  test('removes the installation when the recorded integration has no token', async () => {
    mockAdapter();
    mockedGetInstallationByTeamId.mockResolvedValue(
      buildStoredIntegration({ metadata: { bot_user_id: 'U_EXISTING_OWNER' } })
    );
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockedRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
  });

  test('revokes the incoming token when removing the installation fails', async () => {
    mockAdapter();
    mockDeleteInstallation.mockRejectedValue(new Error('state unavailable'));
    mockedGetInstallationByTeamId.mockResolvedValue(null);
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockedRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  test('removes the installation when the recorded owner cannot be written', async () => {
    mockAdapter();
    mockSetInstallation.mockRejectedValue(new Error('state unavailable'));
    mockedGetInstallationByTeamId.mockResolvedValue(buildStoredIntegration());
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError(TEAM_NAME)
    );

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
    expect(mockDeleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(mockedRevokeSlackToken).toHaveBeenCalledWith(REJECTED_TOKEN);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  test('leaves a same-owner reinstall untouched', async () => {
    mockAdapter();
    mockedUpsertSlackInstallation.mockResolvedValue(buildStoredIntegration());

    const state = createProviderState();
    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/integrations/slack?success=installed');
    expect(mockedUpsertSlackInstallation).toHaveBeenCalledTimes(1);
    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(mockedRevokeSlackToken).not.toHaveBeenCalled();
    expect(mockedGetInstallationByTeamId).not.toHaveBeenCalled();
  });
});
