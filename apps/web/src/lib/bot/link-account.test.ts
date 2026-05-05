const mockCreateLinkAccountTokenFn = jest.fn();

function mockCreateLinkAccountToken(...args: unknown[]) {
  return mockCreateLinkAccountTokenFn(...args);
}

jest.mock('@/lib/bot-identity', () => ({
  createLinkAccountToken: mockCreateLinkAccountToken,
}));

jest.mock(
  'chat',
  () => ({
    Actions: (children: unknown) => ({ type: 'actions', children }),
    Card: (props: unknown) => ({ type: 'card', props }),
    CardText: (text: string) => ({ type: 'card-text', text }),
    LinkButton: (props: unknown) => ({ type: 'link-button', props }),
  }),
  { virtual: true }
);

import type { Message, Thread, Channel, StateAdapter } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { promptLinkAccount } from './link-account';

function createMessage(): Message {
  return {
    id: 'm_1',
    threadId: 'github:Kilo-Org/on-call:issue:37',
    text: '@kilocode-dev Please fix this',
    formatted: { type: 'root', children: [] },
    raw: {},
    author: {
      fullName: 'RSO',
      isBot: false,
      isMe: false,
      userId: '123',
      userName: 'RSO',
    },
    metadata: {
      dateSent: new Date('2026-05-05T07:32:52Z'),
      edited: false,
    },
    attachments: [],
    links: [],
    toJSON: () => ({
      _type: 'chat:Message',
      id: 'm_1',
      threadId: 'github:Kilo-Org/on-call:issue:37',
      text: '@kilocode-dev Please fix this',
      formatted: { type: 'root', children: [] },
      raw: {},
      author: {
        fullName: 'RSO',
        isBot: false,
        isMe: false,
        userId: '123',
        userName: 'RSO',
      },
      metadata: {
        dateSent: '2026-05-05T07:32:52.000Z',
        edited: false,
      },
      attachments: [],
    }),
  };
}

function createThread() {
  const post = jest.fn(async () => undefined);
  const postEphemeral = jest.fn(async () => null);
  const channel = { post, postEphemeral } as unknown as Channel;
  const thread = {
    id: 'github:Kilo-Org/on-call:issue:37',
    channel,
    post,
    postEphemeral,
    toJSON: () => ({
      _type: 'chat:Thread',
      adapterName: 'github',
      channelId: 'github:Kilo-Org/on-call',
      id: 'github:Kilo-Org/on-call:issue:37',
      isDM: false,
    }),
  } as unknown as Thread;

  return { channel, post, postEphemeral, thread };
}

describe('promptLinkAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateLinkAccountTokenFn.mockResolvedValue('link-token');
  });

  it('posts a visible link-account message in GitHub threads', async () => {
    const { post, postEphemeral, thread } = createThread();

    await promptLinkAccount(
      thread,
      createMessage(),
      { platform: PLATFORM.GITHUB, teamId: '98765', userId: '123' },
      {} as StateAdapter
    );

    expect(post).toHaveBeenCalledWith({
      markdown: expect.stringContaining('[Link your Kilo account]'),
    });
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it('uses an ephemeral link-account prompt for non-GitHub platforms', async () => {
    const { post, postEphemeral, thread } = createThread();

    await promptLinkAccount(
      thread,
      createMessage(),
      { platform: PLATFORM.SLACK, teamId: 'T123', userId: '123' },
      {} as StateAdapter
    );

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '123' }),
      expect.anything(),
      { fallbackToDM: true }
    );
  });
});
