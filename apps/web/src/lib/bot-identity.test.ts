import {
  consumeLinkAccountContext,
  createLinkAccountToken,
  unlinkTeamKiloUsers,
  verifyLinkToken,
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
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(
      true
    );
    await expect(consumeLinkAccountContext(state as never, verified.contextKey)).resolves.toBe(
      false
    );
  }
);

/** A Chat SDK state whose Redis client answers SCAN from the scripted batches. */
function buildScanningState(batches: string[][], deletions: string[][]) {
  const state = {
    getClient: () => ({
      async *scanIterator() {
        for (const batch of batches) {
          yield batch;
        }
      },
      async del(keys: string[]) {
        deletions.push(keys);
      },
    }),
  };
  return state as never;
}

test('deletes every key the scan yields and reports the count', async () => {
  const deletions: string[][] = [];
  const state = buildScanningState([['a', 'b'], ['c']], deletions);

  await expect(unlinkTeamKiloUsers(state, 'slack', 'T123')).resolves.toBe(3);
  expect(deletions).toEqual([['a', 'b', 'c']]);
});

test('stops scanning and deleting once the signal aborts, and reports what it deleted', async () => {
  const controller = new AbortController();
  const deletions: string[][] = [];
  const scanned: string[][] = [];
  const state = {
    getClient: () => ({
      async *scanIterator() {
        // One batch per SCAN round trip; the caller aborts after the first delete.
        for (const batch of [
          Array.from({ length: 100 }, (_unused, index) => `k${index}`),
          ['k100'],
          ['k101'],
        ]) {
          scanned.push(batch);
          yield batch;
        }
      },
      async del(keys: string[]) {
        deletions.push(keys);
        controller.abort(new Error('settlement budget spent'));
      },
    }),
  } as never;

  await expect(
    unlinkTeamKiloUsers(state, 'slack', 'T123', { signal: controller.signal })
  ).resolves.toBe(100);
  // The full batch was deleted; the scan ended at the next batch boundary, so the
  // keys the later batches carried were never read or deleted.
  expect(deletions).toHaveLength(1);
  expect(scanned).toHaveLength(2);
});

test('sends no scan and no delete when the signal has already aborted', async () => {
  const deletions: string[][] = [];
  const scanCalls: string[] = [];
  const state = {
    getClient: () => ({
      async *scanIterator() {
        scanCalls.push('scan');
        yield ['a'];
      },
      async del(keys: string[]) {
        deletions.push(keys);
      },
    }),
  } as never;

  await expect(
    unlinkTeamKiloUsers(state, 'slack', 'T123', { signal: AbortSignal.abort() })
  ).resolves.toBe(0);
  expect(scanCalls).toEqual([]);
  expect(deletions).toEqual([]);
});
