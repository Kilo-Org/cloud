import { describe, expect, it } from 'vitest';
import {
  LOCAL_AGENT_ENDPOINTS_STORAGE_KEY,
  loadLocalAgentEndpoints,
  saveLocalAgentEndpoint,
} from './endpoints';
import type { LocalAgentStorageArea } from './storage';

const HUB_A = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const HUB_B = '11111111-2222-4333-8444-555555555555';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS_A = 'ws://127.0.0.1:47917/__kilo_browser';
const WS_B = 'ws://127.0.0.1:48000/__kilo_browser';

const createStorage = (): LocalAgentStorageArea & { items: Map<string, unknown> } => {
  const items = new Map<string, unknown>();

  return {
    getItem: async (key: string) => {
      // Yield so two reads can interleave without the write queue.
      await Promise.resolve();

      return items.get(key) ?? null;
    },
    items,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: async (key: string, value: unknown) => {
      await Promise.resolve();
      items.set(key, value);
    },
  };
};

describe('endpoint storage', () => {
  it('keeps both endpoints when two pairings save in the same tick', async () => {
    const storage = createStorage();

    await Promise.all([
      saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }),
      saveLocalAgentEndpoint(storage, { hubId: HUB_B, key: KEY, ws: WS_B }),
    ]);

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, ws: WS_A },
      { hubId: HUB_B, key: KEY, ws: WS_B },
    ]);
  });

  it('replaces the key and URL when the same hub pairs again', async () => {
    const storage = createStorage();
    const newKey = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A });
    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: newKey, ws: WS_B });

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: newKey, ws: WS_B },
    ]);
  });

  it('refuses to store a non-loopback endpoint', async () => {
    const storage = createStorage();

    await saveLocalAgentEndpoint(storage, {
      hubId: HUB_A,
      key: KEY,
      ws: 'ws://hub.kilo.ai/__kilo_browser',
    });

    expect(storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toBeUndefined();
  });
});
