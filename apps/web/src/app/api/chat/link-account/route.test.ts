import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { bot } from '@/lib/bot';
import { verifyLinkToken, linkKiloUser } from '@/lib/bot-identity';
import { getUserFromAuth } from '@/lib/user.server';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { SerializedMessage } from 'chat';

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
  consumeLinkAccountContext: jest.fn(async () => true),
}));
jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/organizations/organizations', () => ({
  isOrganizationMember: jest.fn(async () => true),
}));
jest.mock('@/lib/bot/run', () => ({
  processLinkedMessage: jest.fn(async () => undefined),
}));
jest.mock('@/lib/bot/platform-auth-context', () => ({
  withBotPlatformAuthContext: jest.fn(async (_integration, callback) => callback()),
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
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

describe('GET /api/chat/link-account', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'kilo-user-id' },
      authFailedResponse: null,
    } as never);
    mockedGetPlatformIntegration.mockResolvedValue({
      owned_by_user_id: 'kilo-user-id',
      owned_by_organization_id: null,
    } as never);
  });

  test('rejects GitHub link token payloads before linking', async () => {
    mockedVerifyLinkToken.mockResolvedValue({
      contextKey: 'context-key',
      identity: { platform: PLATFORM.GITHUB, teamId: '98765', userId: '12345' },
      thread: {
        _type: 'chat:Thread',
        adapterName: 'github',
        channelId: 'github:acme/widgets',
        id: 'github:acme/widgets:issue:1',
        isDM: false,
      },
      message: {
        _type: 'chat:Message',
        attachments: [],
        author: {
          fullName: 'octocat',
          isBot: false,
          isMe: false,
          userId: '12345',
          userName: 'octocat',
        },
        formatted: { type: 'root', children: [] },
        id: 'm_1',
        metadata: {
          dateSent: '2026-05-05T07:32:52.000Z',
          edited: false,
        },
        raw: {},
        text: '@kilocode-dev fix this',
        threadId: 'github:acme/widgets:issue:1',
      } satisfies SerializedMessage,
    });

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/link-account?token=signed') as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('GitHub account links must be created');
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedGetPlatformIntegration).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });
});
