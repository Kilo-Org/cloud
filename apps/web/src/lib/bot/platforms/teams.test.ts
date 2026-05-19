jest.mock(
  'chat',
  () => ({
    Actions: jest.fn((children: unknown) => ({ kind: 'actions', children })),
    Card: jest.fn((options: unknown) => ({ kind: 'card', options })),
    CardText: jest.fn((text: string) => ({ kind: 'text', text })),
    LinkButton: jest.fn((options: unknown) => ({ kind: 'link-button', options })),
  }),
  { virtual: true }
);

import { createTeamsBotPlatform, getTeamsTenantId } from './teams';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { createLinkAccountToken } from '@/lib/bot-identity';
import type { Message, Thread } from 'chat';

jest.mock('@/lib/bot-identity', () => ({
  createLinkAccountToken: jest.fn(async () => 'signed-token'),
}));

const mockedCreateLinkAccountToken = jest.mocked(createLinkAccountToken);

function makeMessage(raw: unknown = {}): Message {
  return {
    id: 'message-1',
    text: '@Kilo fix this',
    raw,
    author: {
      userId: '29:user-id',
      userName: 'Ada',
      fullName: 'Ada Lovelace',
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date('2026-05-19T09:00:00.000Z'), edited: false },
    attachments: [],
    formatted: { type: 'root', children: [] },
    threadId: 'thread-1',
    toJSON: jest.fn(() => ({ _type: 'chat:Message' })),
  } as unknown as Message;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    isDM: false,
    adapter: { name: 'teams' },
    channel: {
      fetchMetadata: jest.fn(async () => ({ id: 'channel-1', isDM: false, metadata: {} })),
      messages: (async function* () {})(),
    },
    messages: (async function* () {})(),
    postEphemeral: jest.fn(async () => ({ id: 'ephemeral-1', usedFallback: true })),
    toJSON: jest.fn(() => ({ _type: 'chat:Thread' })),
    ...overrides,
  } as unknown as Thread;
}

function makeTeamsAdapter() {
  return {
    name: 'teams',
    decodeThreadId: jest.fn(() => ({
      conversationId: '19:conversation',
      serviceUrl: 'https://smba',
    })),
  };
}

describe('createTeamsBotPlatform.getIdentity', () => {
  it('extracts tenant identity from conversation tenantId', async () => {
    const platform = createTeamsBotPlatform(makeTeamsAdapter() as never);

    await expect(
      platform.getIdentity({
        thread: makeThread(),
        message: makeMessage({ conversation: { tenantId: 'tenant-a' } }),
      })
    ).resolves.toEqual({
      platform: PLATFORM.TEAMS,
      teamId: 'tenant-a',
      userId: '29:user-id',
    });
  });

  it('falls back to channelData tenant id', () => {
    expect(getTeamsTenantId(makeMessage({ channelData: { tenant: { id: 'tenant-b' } } }))).toBe(
      'tenant-b'
    );
  });
});

describe('createTeamsBotPlatform', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('only enables bot processing when metadata.bot_enabled is true', () => {
    const platform = createTeamsBotPlatform(makeTeamsAdapter() as never);

    expect(platform.isEnabledForBot({ metadata: { bot_enabled: true } } as never)).toBe(true);
    expect(platform.isEnabledForBot({ metadata: { bot_enabled: false } } as never)).toBe(false);
    expect(platform.isEnabledForBot({ metadata: null } as never)).toBe(false);
  });

  it('sends account-link prompts privately with DM fallback', async () => {
    const platform = createTeamsBotPlatform(makeTeamsAdapter() as never);
    const thread = makeThread();
    const message = makeMessage({ conversation: { tenantId: 'tenant-a' } });
    const identity = { platform: PLATFORM.TEAMS, teamId: 'tenant-a', userId: '29:user-id' };

    await platform.promptLinkAccount({
      thread,
      message,
      identity,
      platformIntegration: { id: 'pi-teams' } as never,
      state: { kind: 'state' } as never,
    });

    expect(mockedCreateLinkAccountToken).toHaveBeenCalledWith(
      expect.objectContaining({ identity, state: { kind: 'state' } })
    );
    expect(thread.postEphemeral).toHaveBeenCalledWith(message.author, expect.anything(), {
      fallbackToDM: true,
    });
  });

  it('sends missing-integration setup prompts privately with DM fallback', async () => {
    const platform = createTeamsBotPlatform(makeTeamsAdapter() as never);
    const thread = makeThread();
    const message = makeMessage({
      conversation: { tenantId: 'tenant-a' },
      channelData: { tenant: { name: 'Acme' } },
    });
    const identity = { platform: PLATFORM.TEAMS, teamId: 'tenant-a', userId: '29:user-id' };

    if (!platform.promptInstallIntegration) throw new Error('Expected Teams install prompt');

    await platform.promptInstallIntegration({
      thread,
      message,
      identity,
      state: { kind: 'state' } as never,
    });

    expect(thread.postEphemeral).toHaveBeenCalledWith(message.author, expect.anything(), {
      fallbackToDM: true,
    });
  });

  it('returns partial/no conversation context when history is unavailable', async () => {
    const platform = createTeamsBotPlatform(makeTeamsAdapter() as never);
    const createFailingIterable = (): AsyncIterable<Message> => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('Graph permission missing');
          },
        };
      },
    });
    const context = await platform.getConversationContext({
      thread: makeThread({
        channel: {
          fetchMetadata: jest.fn(async () => {
            throw new Error('Graph permission missing');
          }),
          messages: createFailingIterable(),
        } as never,
        messages: createFailingIterable(),
      }),
      triggerMessage: makeMessage(),
      platformIntegration: { id: 'pi-teams' } as never,
    });

    expect(context).toContain('Microsoft Teams conversation context');
  });
});
