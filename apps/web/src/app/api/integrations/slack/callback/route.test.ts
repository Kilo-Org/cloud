import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { bot } from '@/lib/bot';
import {
  exchangeSlackOAuthCode,
  getConflictingSlackInstallation,
  SlackWorkspaceAlreadyConnectedError,
  upsertSlackInstallation,
} from '@/lib/integrations/slack-service';

const mockConsumeProviderOAuthAttempt = jest.fn(async (_input: unknown) => true);
const mockCancelProviderOAuthAttempt = jest.fn(async (_input: unknown) => true);

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getAdapter: jest.fn(),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/integrations/slack-service', () => {
  const actual = jest.requireActual('@/lib/integrations/slack-service');
  return {
    ...actual,
    upsertSlackInstallation: jest.fn(),
    exchangeSlackOAuthCode: jest.fn(),
    getConflictingSlackInstallation: jest.fn(),
  };
});
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  consumeProviderOAuthAttempt: (input: unknown) => mockConsumeProviderOAuthAttempt(input),
  cancelProviderOAuthAttempt: (input: unknown) => mockCancelProviderOAuthAttempt(input),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBotGetAdapter = jest.mocked(bot.getAdapter);
const mockedExchangeSlackOAuthCode = jest.mocked(exchangeSlackOAuthCode);
const mockedGetConflictingSlackInstallation = jest.mocked(getConflictingSlackInstallation);
const mockedUpsertSlackInstallation = jest.mocked(upsertSlackInstallation);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const TEAM_ID = 'T024BE7LD';
const createProviderState = (returnTo?: string) =>
  createOAuthState(`user_${USER_ID}`, USER_ID, returnTo, 'provider_install');

const INSTALLATION = {
  botToken: 'xoxb-new-token',
  botUserId: 'U0BOT',
  teamName: 'Acme Workspace',
};

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

async function callSlackCallback(request: NextRequest) {
  const { GET } = await import('../../[platform]/callback/route');
  return GET(request, { params: Promise.resolve({ platform: 'slack' }) });
}

describe('GET /api/integrations/slack/callback', () => {
  let getInstallation: jest.Mock<Promise<unknown>, [string]>;
  let setInstallation: jest.Mock<Promise<void>, [string, unknown]>;
  let deleteInstallation: jest.Mock<Promise<void>, [string]>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockCancelProviderOAuthAttempt.mockResolvedValue(true);

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedExchangeSlackOAuthCode.mockResolvedValue({
      installationId: TEAM_ID,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      installation: INSTALLATION,
    });
    mockedGetConflictingSlackInstallation.mockResolvedValue(null);

    getInstallation = jest.fn<Promise<unknown>, [string]>(async () => null);
    setInstallation = jest.fn<Promise<void>, [string, unknown]>(async () => undefined);
    deleteInstallation = jest.fn<Promise<void>, [string]>(async () => undefined);
    mockedBotGetAdapter.mockReturnValue({
      getInstallation,
      setInstallation,
      deleteInstallation,
    } as never);
  });

  test('redirects to sign-in when the user is unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await callSlackCallback(makeRequest('/api/integrations/slack/callback'));

    expect(response.headers.get('location')).toContain('/users/sign_in');
  });

  test('persists the exchanged installation for an unclaimed workspace', async () => {
    mockedUpsertSlackInstallation.mockResolvedValue({} as never);
    const state = createProviderState();

    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expect(mockedExchangeSlackOAuthCode).toHaveBeenCalledWith('abc');
    expect(mockedGetConflictingSlackInstallation).toHaveBeenCalledWith(
      { type: 'user', id: USER_ID },
      TEAM_ID
    );
    expect(setInstallation).toHaveBeenCalledTimes(1);
    expect(setInstallation).toHaveBeenCalledWith(TEAM_ID, INSTALLATION);
    expect(mockedUpsertSlackInstallation).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      teamId: TEAM_ID,
      installation: INSTALLATION,
    });
    expectRedirectLocation(response, '/integrations/slack?success=installed');
  });

  test('redirects successful installs to returnTo when signed state carries one', async () => {
    mockedUpsertSlackInstallation.mockResolvedValue({} as never);
    const state = createProviderState('/claw/new?step=slack');

    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expectRedirectLocation(response, '/claw/new?step=slack&success=slack_installed');
  });

  test('leaves the stored installation untouched when another owner holds the workspace', async () => {
    mockedGetConflictingSlackInstallation.mockResolvedValue({ id: 'pi_other' } as never);
    const state = createProviderState();

    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expect(setInstallation).not.toHaveBeenCalled();
    expect(deleteInstallation).not.toHaveBeenCalled();
    expect(mockedUpsertSlackInstallation).not.toHaveBeenCalled();
    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
  });

  test('restores the installation it replaced when the workspace is claimed after the check', async () => {
    const previousInstallation = {
      botToken: 'xoxb-prior-token',
      botUserId: 'U0PRIOR',
      teamName: 'Prior Workspace',
    };
    getInstallation.mockResolvedValue(previousInstallation);
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError('Prior Workspace')
    );
    const state = createProviderState();

    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expect(setInstallation).toHaveBeenCalledTimes(2);
    expect(setInstallation).toHaveBeenLastCalledWith(TEAM_ID, previousInstallation);
    expect(deleteInstallation).not.toHaveBeenCalled();
    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
  });

  test('drops only the installation it created when the workspace is claimed after the check', async () => {
    mockedUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceAlreadyConnectedError('Acme Workspace')
    );
    const state = createProviderState();

    const response = await callSlackCallback(
      makeRequest(`/api/integrations/slack/callback?code=abc&state=${state}`)
    );

    expect(getInstallation).toHaveBeenCalledWith(TEAM_ID);
    expect(deleteInstallation).toHaveBeenCalledTimes(1);
    expect(deleteInstallation).toHaveBeenCalledWith(TEAM_ID);
    expectRedirectLocation(response, '/integrations/slack?error=workspace_already_connected');
  });
});
