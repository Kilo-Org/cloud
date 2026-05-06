import { unlinkKiloUserFromBotIdentities } from './bot-identity';
import type { StateAdapter } from 'chat';

function createIncompleteStateAdapter(extra: object = {}): StateAdapter {
  return Object.assign(
    {
      acquireLock: jest.fn(),
      appendToList: jest.fn(),
      connect: jest.fn(),
      delete: jest.fn(),
      dequeue: jest.fn(),
      disconnect: jest.fn(),
      enqueue: jest.fn(),
      extendLock: jest.fn(),
      forceReleaseLock: jest.fn(),
      get: jest.fn(),
      getList: jest.fn(),
      isSubscribed: jest.fn(),
      queueDepth: jest.fn(),
      releaseLock: jest.fn(),
      set: jest.fn(),
      setIfNotExists: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    },
    extra
  );
}

describe('bot identity cleanup', () => {
  it('does not delete identity links when scan access is unavailable', async () => {
    const state = createIncompleteStateAdapter();

    await expect(unlinkKiloUserFromBotIdentities(state, 'kilo-user-1')).resolves.toBe(0);
  });

  it('deletes only Redis identity links for the target Kilo user', async () => {
    const deletedKeys: string[] = [];
    const values = new Map([
      ['chat-sdk:cache:identity:slack:T123:U123', JSON.stringify('kilo-user-1')],
      ['chat-sdk:cache:identity:slack:T123:U456', JSON.stringify('kilo-user-2')],
      ['chat-sdk:cache:identity:github:987:12345', JSON.stringify('kilo-user-1')],
    ]);
    values.set('chat-sdk:cache:unrelated', JSON.stringify('kilo-user-1'));
    const state = createIncompleteStateAdapter({
      getClient: () => ({
        async *scanIterator() {
          yield [...values.keys()].filter(key => key.startsWith('chat-sdk:cache:identity:'));
        },
        get: async (key: string) => values.get(key) ?? null,
        del: async (keys: string[]) => {
          deletedKeys.push(...keys);
          for (const key of keys) {
            values.delete(key);
          }
        },
      }),
    });

    const deletedCount = await unlinkKiloUserFromBotIdentities(state, 'kilo-user-1');

    expect(deletedCount).toBe(2);
    expect(deletedKeys).toEqual([
      'chat-sdk:cache:identity:slack:T123:U123',
      'chat-sdk:cache:identity:github:987:12345',
    ]);
    expect(values.has('chat-sdk:cache:identity:slack:T123:U456')).toBe(true);
    expect(values.has('chat-sdk:cache:unrelated')).toBe(true);
  });
});
