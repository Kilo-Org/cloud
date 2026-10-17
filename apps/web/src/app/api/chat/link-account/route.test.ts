import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { bot } from '@/lib/bot';
import { consumeLinkAccountContext, verifyLinkToken, linkKiloUser } from '@/lib/bot-identity';
import type { PlatformIdentity } from '@/lib/bot-identity';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { GET, POST } from './route';
import type { SerializedMessage } from 'chat';

const APP_ORIGIN = new URL(APP_URL).origin;
const LINK_PATH = '/api/chat/link-account';

const mockedAfter = jest.fn();

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => mockedAfter(fn),
  };
});
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => ({ kind: 'state' })),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  verifyLinkToken: jest.fn(),
  linkKiloUser: jest.fn(async () => undefined),
  consumeLinkAccountContext: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({
      usesGenericLinkAccountRoute: true,
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    })),
  },
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  isOrganizationMember: jest.fn(async () => true),
}));
jest.mock('@/lib/bot/run', () => ({
  processLinkedMessage: jest.fn(async () => undefined),
}));
jest.mock(
  'chat',
  () => ({
    Message: {
      fromJSON: jest.fn(value => value),
    },
    ThreadImpl: {
      fromJSON: jest.fn(value => value),
    },
  }),
  { virtual: true }
);
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedBot = jest.mocked(bot);
const mockedVerifyLinkToken = jest.mocked(verifyLinkToken);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedConsumeLinkAccountContext = jest.mocked(consumeLinkAccountContext);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedBotPlatforms = jest.mocked(botPlatforms);
const mockedProcessLinkedMessage = jest.mocked(processLinkedMessage);

const slackIdentity: PlatformIdentity = { platform: PLATFORM.SLACK, teamId: 'T123', userId: 'U123' };

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
      _type: 'chat:Message',
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

function getRequest(pathAndQuery: string) {
  return new NextRequest(`${APP_ORIGIN}${pathAndQuery}`);
}

function postRequest({
  token = 'signed',
  origin = APP_ORIGIN,
  secFetchSite,
}: {
  token?: string | null;
  origin?: string | null;
  secFetchSite?: string;
} = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  if (secFetchSite) headers.set('sec-fetch-site', secFetchSite);

  const body = new URLSearchParams();
  if (token !== null) body.set('token', token);

  return new NextRequest(`${APP_ORIGIN}${LINK_PATH}`, { method: 'POST', headers, body });
}

beforeEach(() => {
  jest.clearAllMocks();

  mockedBotPlatforms.require.mockReturnValue({
    usesGenericLinkAccountRoute: true,
    withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
  } as never);

  mockedGetUserFromAuth.mockResolvedValue({
    user: { id: 'kilo-user-id', google_user_email: 'kilo@example.com' },
    authFailedResponse: null,
  } as never);
  mockedGetPlatformIntegration.mockResolvedValue({
    owned_by_user_id: 'kilo-user-id',
    owned_by_organization_id: null,
  } as never);
  mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
  mockedConsumeLinkAccountContext.mockResolvedValue(true);
});

describe('GET /api/chat/link-account', () => {
  test('renders the confirmation page', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await GET(getRequest(`${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Link your Kilo account');
    expect(html).toContain(`<form method="post" action="${LINK_PATH}">`);
    expect(html).toContain('name="token" value="signed"');
    expect(html).toContain('U123');
    expect(html).toContain('T123');
    expect(html).toContain('kilo@example.com');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');

    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedConsumeLinkAccountContext).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('rejects GitHub link token payloads before linking', async () => {
    mockedBotPlatforms.require.mockReturnValue({
      usesGenericLinkAccountRoute: false,
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    } as never);
    mockedVerifyLinkToken.mockResolvedValue(
      verifiedToken({ platform: PLATFORM.GITHUB, teamId: '98765', userId: '12345' })
    );

    const response = await GET(getRequest(`${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      'github account links must be created from the platform-specific link page'
    );
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedGetPlatformIntegration).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('rejects link requests when the user cannot access the integration owner', async () => {
    const integration = {
      owned_by_user_id: null,
      owned_by_organization_id: 'org-1',
    };
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetPlatformIntegration.mockResolvedValue(integration as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const response = await GET(getRequest(`${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Access Denied');
    expect(mockedCanKiloUserAccessPlatformIntegration).toHaveBeenCalledWith(
      expect.objectContaining(integration),
      'kilo-user-id'
    );
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('sends the user to sign-in when there is no session', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await GET(getRequest(`${LINK_PATH}?token=signed`) as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/users/sign_in');
    expect(response.headers.get('location')).toContain('callbackPath');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedConsumeLinkAccountContext).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/link-account', () => {
  test('writes the link for a confirmation from the app origin', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const response = await POST(postRequest({ secFetchSite: 'same-origin' }) as never);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Account linked');

    expect(mockedConsumeLinkAccountContext).toHaveBeenCalledWith(
      expect.anything(),
      'context-key'
    );
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      expect.anything(),
      slackIdentity,
      'kilo-user-id'
    );
    expect(mockedConsumeLinkAccountContext.mock.invocationCallOrder[0]).toBeLessThan(
      mockedLinkKiloUser.mock.invocationCallOrder[0]!
    );

    expect(mockedAfter).toHaveBeenCalledTimes(1);
    await mockedAfter.mock.calls[0]![0]();
    expect(mockedProcessLinkedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        platformIntegration: expect.objectContaining({ owned_by_user_id: 'kilo-user-id' }),
        user: expect.objectContaining({ id: 'kilo-user-id' }),
      })
    );
  });

  test('requires a submission from the app origin', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());

    const crossSite = await POST(
      postRequest({ origin: 'https://evil.example', secFetchSite: 'cross-site' }) as never
    );
    const noOrigin = await POST(postRequest({ origin: null }) as never);

    expect(crossSite.status).toBe(403);
    await expect(crossSite.text()).resolves.toContain('Invalid Request');
    expect(noOrigin.status).toBe(403);

    expect(mockedVerifyLinkToken).not.toHaveBeenCalled();
    expect(mockedConsumeLinkAccountContext).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('completes a link at most once', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedConsumeLinkAccountContext.mockResolvedValue(false);

    const response = await POST(postRequest({ secFetchSite: 'same-origin' }) as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Link Already Used');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('writes nothing when the user cannot access the integration owner', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const response = await POST(postRequest({ secFetchSite: 'same-origin' }) as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Access Denied');
    expect(mockedConsumeLinkAccountContext).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('requires the token in the form body', async () => {
    const response = await POST(postRequest({ token: null }) as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Missing token parameter');
    expect(mockedVerifyLinkToken).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('sends the user to sign-in when there is no session', async () => {
    mockedVerifyLinkToken.mockResolvedValue(verifiedToken());
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await POST(postRequest({ secFetchSite: 'same-origin' }) as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/users/sign_in');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedConsumeLinkAccountContext).not.toHaveBeenCalled();
  });
});
