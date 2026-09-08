import { consumeLinkAccountContext, createLinkAccountToken, verifyLinkToken } from './bot-identity';

const thread = {
  _type: 'chat:Thread',
  adapterName: 'github',
  channelId: 'repo',
  id: 'thread',
  isDM: false,
};
const message = {
  _type: 'chat:Message',
  attachments: [],
  author: {
    userId: 'github-user',
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  },
  formatted: null,
  id: 'message',
  metadata: { dateSent: '2026-09-08T00:00:00.000Z', edited: false },
  raw: null,
  text: 'link',
  threadId: 'thread',
};

test.each(['standard', 'lite'] as const)(
  'preserves %s app identity through signed link token verification and replay protection',
  async githubAppType => {
    const values = new Map<string, unknown>();
    const state = {
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      get: async (key: string) => values.get(key),
      setIfNotExists: async (key: string, value: unknown) => {
        if (values.has(key)) return false;
        values.set(key, value);
        return true;
      },
    };
    const token = await createLinkAccountToken({
      identity: { platform: 'github', teamId: '777', userId: 'github-user', githubAppType },
      thread: thread as never,
      message: message as never,
      state: state as never,
    });
    const verified = await verifyLinkToken(state as never, token);
    expect(verified?.identity).toEqual({
      platform: 'github',
      teamId: '777',
      userId: 'github-user',
      githubAppType,
    });
    if (!verified) throw new Error('Expected verified link token');
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(true);
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(false);
  }
);
