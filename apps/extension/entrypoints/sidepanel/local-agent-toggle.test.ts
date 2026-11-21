import { describe, expect, it } from 'vitest';
import { setLocalAgentsEnabled } from './local-agent-toggle';
import { LOCAL_AGENT_SETTINGS_STORAGE_KEY } from '@/src/shared/local-agents/settings';
import type { LocalAgentStorageArea } from '@/src/shared/local-agents/storage';

const createStorage = () => {
  const writes: unknown[] = [];
  const storage: LocalAgentStorageArea = {
    getItem: () => null,
    removeItem: () => {
      /* Nothing to remove in this fake. */
    },
    setItem: (key, value) => {
      expect(key).toBe(LOCAL_AGENT_SETTINGS_STORAGE_KEY);
      writes.push(value);
    },
  };

  return { storage, writes };
};

describe('local agents switch', () => {
  it('asks for the native permission before it persists the switch', async () => {
    const { storage, writes } = createStorage();
    const order: string[] = [];

    await setLocalAgentsEnabled({
      next: true,
      requestPermission: () => {
        order.push('permission');

        return Promise.resolve();
      },
      storage,
    });
    order.push('saved');

    expect(order).toStrictEqual(['permission', 'saved']);
    expect(writes).toStrictEqual([{ enabled: true }]);
  });

  it('persists a switch-off without asking for a permission', async () => {
    const { storage, writes } = createStorage();
    let asked = 0;

    await setLocalAgentsEnabled({
      next: false,
      requestPermission: () => {
        asked += 1;

        return Promise.resolve();
      },
      storage,
    });

    expect(asked).toBe(0);
    expect(writes).toStrictEqual([{ enabled: false }]);
  });
});
