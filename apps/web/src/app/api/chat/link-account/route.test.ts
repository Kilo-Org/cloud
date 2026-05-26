import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { bot } from '@/lib/bot';
import { verifyLinkToken, linkKiloUser } from '@/lib/bot-identity';
import { getUserFromAuth } from '@/lib/user/server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
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
jest.mock('@/lib/user/server');
jest.mock('@/lib/bot/platform-helpers');
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({
      usesGenericLinkAccountRoute: true,
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    })),
  },
}));
jest.mock('@/lib/organizations/organizations', () => ({
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
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedBotPlatforms = jest.mocked(botPlatforms);

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

describe('GET /api/chat/link-account', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedBotPlatforms.require.mockReturnValue({
      usesGenericLinkAccountRoute: true,
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    } as never);

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'kilo-user-id' },
      authFailedResponse: null,
    } as never);
    mockedGetPlatformIntegration.mockResolvedValue({
      owned_by_user_id: 'kilo-user-id',
      owned_by_organization_id: null,
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
  });

  test('rejects GitHub link token payloads before linking', async () => {
    mockedBotPlatforms.require.mockReturnValue({
      usesGenericLinkAccountRoute: false,
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    } as never);
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
    const identity = { platform: PLATFORM.SLACK, teamId: 'T123', userId: 'U123' };
    const integration = {
      owned_by_user_id: null,
      owned_by_organization_id: 'org-1',
    };
    mockedVerifyLinkToken.mockResolvedValue({
      contextKey: 'context-key',
      identity,
      thread: {
        _type: 'chat:Thread',
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
    });
    mockedGetPlatformIntegration.mockResolvedValue(integration as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/link-account?token=signed') as never);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('Access Denied');
    expect(mockedCanKiloUserAccessPlatformIntegration).toHaveBeenCalledWith(
      expect.objectContaining(integration),
      'kilo-user-id'
    );
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });
});
