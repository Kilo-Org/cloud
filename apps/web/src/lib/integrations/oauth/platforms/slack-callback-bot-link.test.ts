process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockAfter = jest.fn();
const mockExchangeSlackOidcCode = jest.fn();
const mockFetchSlackIdentity = jest.fn();
const mockRevokeSlackOidcToken = jest.fn(async (_accessToken: string) => undefined);
const mockProcessLinkedMessage = jest.fn(async (_params: unknown) => undefined);

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => mockAfter(fn),
  };
});
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(async () => 'owner'),
}));
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  beginProviderOAuthAttempt: jest.fn(),
  cancelProviderOAuthAttempt: jest.fn(),
  consumeProviderOAuthAttempt: jest.fn(async () => true),
}));
jest.mock('@/lib/integrations/slack-service', () => ({
  SlackWorkspaceAlreadyConnectedError: class extends Error {},
  exchangeSlackOAuthCode: jest.fn(),
  getConflictingSlackInstallation: jest.fn(async () => null),
  upsertSlackInstallation: jest.fn(),
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(),
    getAdapter: jest.fn(),
  },
}));
jest.mock('@/lib/integrations/slack-oidc', () => ({
  exchangeSlackOidcCode: (code: string) => mockExchangeSlackOidcCode(code),
  fetchSlackIdentity: (accessToken: string) => mockFetchSlackIdentity(accessToken),
  revokeSlackOidcToken: (accessToken: string) => mockRevokeSlackOidcToken(accessToken),
}));
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    })),
  },
}));
jest.mock('@/lib/bot/run', () => ({
  processLinkedMessage: (params: unknown) => mockProcessLinkedMessage(params),
}));
jest.mock(
  'chat',
  () => ({
    Message: { fromJSON: jest.fn((value: unknown) => value) },
    ThreadImpl: { fromJSON: jest.fn((value: unknown) => value) },
  }),
  { virtual: true }
);

import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { bot } from '@/lib/bot';
import { resolveKiloUserId } from '@/lib/bot-identity';
import { createSlackBotLinkState } from '@/lib/bot/slack-link-state';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { handleSlackOAuthCallback } from './slack-callback';

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBot = jest.mocked(bot);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedCanAccess = jest.mocked(canKiloUserAccessPlatformIntegration);

const KILO_USER_ID = 'kilo-user-1';
const OTHER_KILO_USER_ID = 'kilo-user-2';
const SLACK_TEAM_ID = 'T123';
const SLACK_USER_ID = 'U123';
const CONTEXT_KEY = 'link-account-context:pending';

type FakeState = {
  values: Map<string, unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  setIfNotExists(key: string, value: unknown, ttl?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
};

function createFakeState(): FakeState {
  const values = new Map<string, unknown>();
  return {
    values,
    set: async (key, value) => {
      values.set(key, value);
    },
    get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
    setIfNotExists: async (key, value) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    delete: async key => {
      values.delete(key);
    },
  };
}

const threadJson = {
  _type: 'chat:Thread' as const,
  adapterName: 'slack',
  channelId: 'C123',
  id: 'slack:C123:1',
  isDM: false,
};

const messageJson = {
  _type: 'chat:Message' as const,
  attachments: [],
  author: {
    userId: SLACK_USER_ID,
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  },
  formatted: null,
  id: 'm_1',
  metadata: { dateSent: '2026-05-05T07:32:52.000Z', edited: false },
  raw: {},
  text: '@Kilo fix this',
  threadId: 'slack:C123:1',
};

let state: FakeState;

/** Store the pending-link context the way the bot's link prompt does. */
async function seedPendingLink() {
  await state.set(CONTEXT_KEY, { thread: threadJson, message: messageJson });
  return CONTEXT_KEY;
}

function botLinkState(contextKey: string, userId = KILO_USER_ID) {
  return createSlackBotLinkState({
    userId,
    slackTeamId: SLACK_TEAM_ID,
    slackUserId: SLACK_USER_ID,
    contextKey,
  });
}

async function callCallback(params: {
  state: string;
  code?: string | null;
  error?: string | null;
}) {
  const query = new URLSearchParams();
  if (params.code !== null) query.set('code', params.code ?? 'oidc-code');
  if (params.error) query.set('error', params.error);
  query.set('state', params.state);

  return await handleSlackOAuthCallback(
    new NextRequest(`http://localhost:3000/api/integrations/slack/callback?${query.toString()}`)
  );
}

function slackIdentity(teamId = SLACK_TEAM_ID, userId = SLACK_USER_ID) {
  return { teamId, userId };
}

async function mappedKiloUser() {
  return await resolveKiloUserId(state as never, {
    platform: 'slack',
    teamId: SLACK_TEAM_ID,
    userId: SLACK_USER_ID,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  state = createFakeState();
  mockedBot.getState.mockReturnValue(state as never);
  mockedGetUserFromAuth.mockResolvedValue({
    user: { id: KILO_USER_ID, google_user_email: 'kilo@example.com' },
    authFailedResponse: null,
  } as never);
  mockedGetPlatformIntegration.mockResolvedValue({
    id: 'integration-1',
    platform: 'slack',
    platform_installation_id: SLACK_TEAM_ID,
    owned_by_user_id: KILO_USER_ID,
    owned_by_organization_id: null,
  } as never);
  mockedCanAccess.mockResolvedValue(true);
  mockExchangeSlackOidcCode.mockResolvedValue('xoxp-oidc');
  mockFetchSlackIdentity.mockResolvedValue(slackIdentity());
});

describe('handleSlackOAuthCallback Slack bot-link', () => {
  it('links the mapping the identity Slack asserted for the signed-in user', async () => {
    const contextKey = await seedPendingLink();

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Account linked');
    expect(mockExchangeSlackOidcCode).toHaveBeenCalledWith('oidc-code');
    expect(mockRevokeSlackOidcToken).toHaveBeenCalledWith('xoxp-oidc');
    await expect(mappedKiloUser()).resolves.toBe(KILO_USER_ID);
    expect(state.values.has(`${contextKey}:consumed`)).toBe(true);
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it('rejects an identity mismatch without consuming the link or writing a mapping', async () => {
    const contextKey = await seedPendingLink();
    mockFetchSlackIdentity.mockResolvedValue(slackIdentity(SLACK_TEAM_ID, 'U_SOMEONE_ELSE'));

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('different Slack account');
    await expect(mappedKiloUser()).resolves.toBeNull();
    expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('rejects a workspace mismatch from the same Slack user id', async () => {
    const contextKey = await seedPendingLink();
    mockFetchSlackIdentity.mockResolvedValue(slackIdentity('T_OTHER', SLACK_USER_ID));

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(403);
    await expect(mappedKiloUser()).resolves.toBeNull();
    expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
  });

  it('rejects a callback finished by a different Kilo user', async () => {
    const contextKey = await seedPendingLink();

    const response = await callCallback({ state: botLinkState(contextKey, OTHER_KILO_USER_ID) });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('another Kilo user');
    expect(mockExchangeSlackOidcCode).not.toHaveBeenCalled();
    expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
  });

  it('reports a conflict and keeps the existing mapping for another Kilo account', async () => {
    await state.set(`identity:slack:${SLACK_TEAM_ID}:${SLACK_USER_ID}`, OTHER_KILO_USER_ID);
    const contextKey = await seedPendingLink();

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain('already linked to a different Kilo account');
    await expect(mappedKiloUser()).resolves.toBe(OTHER_KILO_USER_ID);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('completes a link at most once', async () => {
    const contextKey = await seedPendingLink();
    await state.set(`${contextKey}:consumed`, true);

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Link Already Used');
    await expect(mappedKiloUser()).resolves.toBeNull();
  });

  it('reports an expired link when the pending context is gone', async () => {
    const response = await callCallback({
      state: botLinkState('link-account-context:deleted'),
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Link Expired');
    await expect(mappedKiloUser()).resolves.toBeNull();
  });

  it('refuses the callback when the user lost access to the integration', async () => {
    const contextKey = await seedPendingLink();
    mockedCanAccess.mockResolvedValue(false);

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('do not have access');
    expect(mockExchangeSlackOidcCode).not.toHaveBeenCalled();
    expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
  });

  it('does not run install logic for a bot-link state', async () => {
    const contextKey = await seedPendingLink();

    await callCallback({ state: botLinkState(contextKey) });

    expect(mockedBot.getAdapter).not.toHaveBeenCalled();
  });

  it('reports a failed identity proof without writing a mapping', async () => {
    const contextKey = await seedPendingLink();
    mockExchangeSlackOidcCode.mockRejectedValue(new Error('slack down'));

    const response = await callCallback({ state: botLinkState(contextKey) });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('could not confirm your Slack account');
    expect(state.values.has(`${contextKey}:consumed`)).toBe(false);
    await expect(mappedKiloUser()).resolves.toBeNull();
  });

  it('rejects a Slack error response', async () => {
    const response = await callCallback({
      state: botLinkState('link-account-context:whatever'),
      code: null,
      error: 'access_denied',
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('was not completed');
    expect(mockExchangeSlackOidcCode).not.toHaveBeenCalled();
  });
});
