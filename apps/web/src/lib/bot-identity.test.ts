import {
  consumeLinkAccountContext,
  createLinkAccountToken,
  linkKiloUser,
  loadLinkAccountContext,
  resolveKiloUserId,
  verifyLinkToken,
  type PlatformIdentity,
} from './bot-identity';

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

function createState() {
  const values = new Map<string, unknown>();
  return {
    values,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    get: async (key: string) => values.get(key),
    setIfNotExists: async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

const slackIdentity: PlatformIdentity = { platform: 'slack', teamId: 'T1', userId: 'U1' };

test.each(['standard', 'lite'] as const)(
  'preserves %s app identity through signed link token verification and replay protection',
  async githubAppType => {
    const state = createState();
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
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(
      true
    );
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(
      false
    );
  }
);

test('rejects a link token whose stored context expired', async () => {
  const state = createState();
  const token = await createLinkAccountToken({
    identity: slackIdentity,
    thread: thread as never,
    message: message as never,
    state: state as never,
  });

  for (const key of [...state.values.keys()]) {
    if (!key.endsWith(':consumed')) state.values.delete(key);
  }

  await expect(verifyLinkToken(state as never, token)).resolves.toBeNull();
});

test('loadLinkAccountContext returns the stored thread and message', async () => {
  const state = createState();
  await createLinkAccountToken({
    identity: slackIdentity,
    thread: thread as never,
    message: message as never,
    state: state as never,
  });

  const [contextKey] = [...state.values.keys()];
  const context = await loadLinkAccountContext(state as never, contextKey!);

  expect(context?.thread).toEqual(thread);
  expect(context?.message).toEqual(message);
  await expect(loadLinkAccountContext(state as never, 'missing-key')).resolves.toBeNull();
});

describe('linkKiloUser', () => {
  test('links an unmapped platform identity', async () => {
    const state = createState();

    await expect(linkKiloUser(state as never, slackIdentity, 'kilo-1')).resolves.toBe('linked');
    await expect(resolveKiloUserId(state as never, slackIdentity)).resolves.toBe('kilo-1');
  });

  test('re-linking the same Kilo user is idempotent', async () => {
    const state = createState();

    await linkKiloUser(state as never, slackIdentity, 'kilo-1');
    await expect(linkKiloUser(state as never, slackIdentity, 'kilo-1')).resolves.toBe('linked');
    await expect(resolveKiloUserId(state as never, slackIdentity)).resolves.toBe('kilo-1');
  });

  test('refuses to reassign an identity held by another Kilo user', async () => {
    const state = createState();

    await linkKiloUser(state as never, slackIdentity, 'kilo-1');
    await expect(linkKiloUser(state as never, slackIdentity, 'kilo-2')).resolves.toBe('conflict');
    // The original mapping is untouched.
    await expect(resolveKiloUserId(state as never, slackIdentity)).resolves.toBe('kilo-1');
  });

  test('losing a concurrent write to the same user still reports linked', async () => {
    const state = createState();
    // Simulates the other request winning the race between setIfNotExists and
    // the follow-up read, for the same Kilo user.
    await state.set('identity:slack:T1:U1', 'kilo-1');

    await expect(linkKiloUser(state as never, slackIdentity, 'kilo-1')).resolves.toBe('linked');
  });

  test('losing a concurrent write to another user reports conflict', async () => {
    const state = createState();
    await state.set('identity:slack:T1:U1', 'kilo-2');

    await expect(linkKiloUser(state as never, slackIdentity, 'kilo-1')).resolves.toBe('conflict');
    await expect(resolveKiloUserId(state as never, slackIdentity)).resolves.toBe('kilo-2');
  });
});
