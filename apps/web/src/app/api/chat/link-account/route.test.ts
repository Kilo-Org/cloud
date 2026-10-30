import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { bot } from '@/lib/bot';
import { verifyLinkToken } from '@/lib/bot-identity';
import type { PlatformIdentity } from '@/lib/bot-identity';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { verifySlackBotLinkState } from '@/lib/bot/slack-link-state';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { GET, POST } from './route';
import type { SerializedMessage } from 'chat';

const APP_ORIGIN = new URL(APP_URL).origin;
const LINK_PATH = '/api/chat/link-account';
const PROOF_URL = 'https://slack.com/openid/connect/authorize?state=signed-proof-state';

const mockedBeginLinkAccountProof = jest.fn((_params: unknown) => PROOF_URL);

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  verifyLinkToken: jest.fn(),
  loadLinkAccountContext: jest.fn(),
  consumeLinkAccountContext: jest.fn(),
  linkKiloUser: jest.fn(),
}));
jest.mock('@/lib/bot/link-account-completion', () => ({
  completeLinkAccount: jest.fn(),
  reprocessLinkedContext: jest.fn(async () => undefined),
}));
jest.mock('@/lib/bot/slack-link-state');
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(),
  },
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedBot = jest.mocked(bot);
const mockedVerifyLinkToken = jest.mocked(verifyLinkToken);
const mockedVerifySlackBotLinkState = jest.mocked(verifySlackBotLinkState);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedBotPlatforms = jest.mocked(botPlatforms);

const slackIdentity: PlatformIdentity = {
  platform: PLATFORM.SLACK,
  teamId: 'T123',
  userId: 'U123',
};

function verifiedToken(identity: PlatformIdentity = slackIdentity) {
  return {
    contextKey: 'context-key',
    identity,
    thread: {
      _type: 'chat:Thread' as const,
      adapterName: 'slack',
      channelId: 'C123',
      id: 'slack:C123:1',
      isDM: false,
    },
    message: {
      _type: 'chat:Message' as const,
      attachments: [],
      author: {
        fullName: 'User',
        isBot: false,
        isMe: false,
        userId: 'U123',
        userName: 'user',
      },
      formatted: { type: 'root', children: [] },
      id: 'm_1',
      metadata: {
        dateSent: '2026-05-05T07:32:52.000Z',
        edited: false,
      },
      raw: {},
      text: '@Kilo fix this',
      threadId: 'slack:C123:1',
    } satisfies SerializedMessage,
  };
}

function postRequest({
  token = 'signed',
  origin = APP_ORIGIN,
}: {
  token?: string | null;
  origin?: string | null;
} = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);

  const body = new URLSearchParams();
  if (token !== null) body.set('token', token);

  return new NextRequest(`${APP_ORIGIN}${LINK_PATH}`, { method: 'POST', headers, body });
}

beforeEach(() => {
  jest.clearAllMocks();

  mockedBotPlatforms.require.mockReturnValue({
    usesGenericLinkAccountRoute: true,
    beginLinkAccountProof: mockedBeginLinkAccountProof,
    withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
  } as never);

  mockedVerifySlackBotLinkState.mockReturnValue({
    userId: 'kilo-user-id',
    slackTeamId: 'T123',
    slackUserId: 'U123',
    contextKey: 'context-key',
  });

  mockedGetUserFromAuth.mockResolvedValue({
    user: { id: 'kilo-user-id', google_user_email: 'kilo@example.com' },
    authFailedResponse: null,
  } as never);
  mockedGetPlatformIntegration.mockResolvedValue({
    owned_by_user_id: 'kilo-user-id',
    owned_by_organization_id: null,
  } as never);
  mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
});

describe('GET /api/chat/link-account', () => {
  test('renders the confirmation page and writes nothing', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await GET(new NextRequest(`${APP_ORIGIN}${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Link your Kilo account');
    expect(html).toContain(`<form method="post" action="${LINK_PATH}">`);
    expect(html).toContain('name="token" value="signed"');
    expect(html).toContain('U123');
    expect(html).toContain('T123');
    expect(html).toContain('kilo@example.com');
    // The page states that the next step signs in to Slack as the named user.
    expect(html).toContain('sign in to slack as the slack user named above');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('rejects platforms without the generic route', async () => {
    mockedBotPlatforms.require.mockReturnValue({
      usesGenericLinkAccountRoute: false,
    } as never);
    mockedVerifyLinkToken.mockResolvedValue(
      verifiedToken({ platform: PLATFORM.GITHUB, teamId: '98765', userId: '12345' })
    );

    const response = await GET(new NextRequest(`${APP_ORIGIN}${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      'github account links must be created from the platform-specific link page'
    );
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('refuses a user who cannot access the integration owner', async () => {
    const integration = { owned_by_user_id: null, owned_by_organization_id: 'org-1' };
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetPlatformIntegration.mockResolvedValue(integration as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const response = await GET(new NextRequest(`${APP_ORIGIN}${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Access Denied');
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('sends the user to sign-in when there is no session', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await GET(new NextRequest(`${APP_ORIGIN}${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/users/sign_in');
    expect(response.headers.get('location')).toContain('callbackPath');
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/link-account', () => {
  test('redirects to the platform identity proof instead of writing the mapping', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await POST(postRequest() as never);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(PROOF_URL);
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedBeginLinkAccountProof).toHaveBeenCalledWith({
      identity: slackIdentity,
      contextKey: 'context-key',
      user: expect.objectContaining({ id: 'kilo-user-id' }),
    });
  });

  test('requires a submission from the app origin', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await POST(postRequest({ origin: 'https://evil.example' }) as never);
    const noOrigin = await POST(postRequest({ origin: null }) as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Invalid Request');
    expect(noOrigin.status).toBe(403);
    expect(mockedVerifyLinkToken).not.toHaveBeenCalled();
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('writes nothing when the user cannot access the integration owner', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const response = await POST(postRequest() as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Access Denied');
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('requires the token in the form body', async () => {
    const response = await POST(postRequest({ token: null }) as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Missing token parameter');
    expect(mockedVerifyLinkToken).not.toHaveBeenCalled();
  });

  test('sends the user to sign-in when there is no session', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await POST(postRequest() as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/users/sign_in');
    expect(mockedBeginLinkAccountProof).not.toHaveBeenCalled();
  });

  test('refuses linking when the platform has no identity proof', async () => {
    mockedBotPlatforms.require.mockReturnValue({
      usesGenericLinkAccountRoute: true,
    } as never);
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await POST(postRequest() as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Link Not Supported');
  });
});
