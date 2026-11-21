import { describe, expect, it } from 'vitest';
import {
  LOCAL_AGENT_ENDPOINTS_STORAGE_KEY,
  LOCAL_AGENT_ENDPOINT_REFRESH_MS,
  LOCAL_AGENT_ENDPOINT_STALE_MS,
  loadLocalAgentEndpoints,
  pruneLocalAgentEndpoints,
  saveLocalAgentEndpoint,
  touchLocalAgentEndpoint,
} from './endpoints';
import type { LocalAgentStorageArea } from './storage';

const HUB_A = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const HUB_B = '11111111-2222-4333-8444-555555555555';
const HUB_C = '99999999-8888-4777-8666-555555555555';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS_A = 'ws://127.0.0.1:47917/__kilo_browser';
const WS_B = 'ws://127.0.0.1:48000/__kilo_browser';
const WS_C = 'ws://127.0.0.1:48001/__kilo_browser';
const DAY_LATER = LOCAL_AGENT_ENDPOINT_STALE_MS + 5000;

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
      saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }, 10),
      saveLocalAgentEndpoint(storage, { hubId: HUB_B, key: KEY, ws: WS_B }, 20),
    ]);

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, lastConnectedAt: 10, ws: WS_A },
      { hubId: HUB_B, key: KEY, lastConnectedAt: 20, ws: WS_B },
    ]);
  });

  it('reads an endpoint stored before the stamp existed and starts its clock', async () => {
    const storage = createStorage();
    storage.items.set(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY, {
      endpoints: [{ hubId: HUB_A, key: KEY, ws: WS_A }],
    });

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, ws: WS_A },
    ]);
    await expect(
      pruneLocalAgentEndpoints(storage, { isConnected: () => false, now: 5000 })
    ).resolves.toStrictEqual([{ hubId: HUB_A, key: KEY, lastConnectedAt: 5000, ws: WS_A }]);
    expect(storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toStrictEqual({
      endpoints: [{ hubId: HUB_A, key: KEY, lastConnectedAt: 5000, ws: WS_A }],
    });
  });

  it('replaces the key and URL when the same hub pairs again', async () => {
    const storage = createStorage();
    const newKey = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }, 10);
    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: newKey, ws: WS_B }, 20);

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: newKey, lastConnectedAt: 20, ws: WS_B },
    ]);
  });

  it('drops the endpoint of a hub that a newer pairing replaced on the same socket URL', async () => {
    const storage = createStorage();

    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }, 10);
    await saveLocalAgentEndpoint(storage, { hubId: HUB_C, key: KEY, ws: WS_C }, 15);
    await saveLocalAgentEndpoint(storage, { hubId: HUB_B, key: KEY, ws: WS_A }, 20);

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_C, key: KEY, lastConnectedAt: 15, ws: WS_C },
      { hubId: HUB_B, key: KEY, lastConnectedAt: 20, ws: WS_A },
    ]);
  });

  it('refuses to store a non-loopback endpoint', async () => {
    const storage = createStorage();

    await saveLocalAgentEndpoint(
      storage,
      { hubId: HUB_A, key: KEY, ws: 'ws://hub.kilo.ai/__kilo_browser' },
      10
    );

    expect(storage.items.get(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)).toBeUndefined();
  });

  it('removes an endpoint not connected now after a day without a connection', async () => {
    const storage = createStorage();
    storage.items.set(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY, {
      endpoints: [
        { hubId: HUB_A, key: KEY, lastConnectedAt: 0, ws: WS_A },
        // Stored before the stamp existed: its clock starts now.
        { hubId: HUB_B, key: KEY, ws: WS_B },
        // Just as old, but connected right now: its stamp is refreshed instead.
        { hubId: HUB_C, key: KEY, lastConnectedAt: 0, ws: WS_C },
      ],
    });

    const kept = await pruneLocalAgentEndpoints(storage, {
      isConnected: hubId => hubId === HUB_C,
      now: DAY_LATER,
    });

    const expected = [
      { hubId: HUB_B, key: KEY, lastConnectedAt: DAY_LATER, ws: WS_B },
      { hubId: HUB_C, key: KEY, lastConnectedAt: DAY_LATER, ws: WS_C },
    ];

    expect(kept).toStrictEqual(expected);
    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual(expected);
  });

  it('keeps an endpoint reachable within the day, and refreshes a connected one only hourly', async () => {
    const storage = createStorage();
    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }, 10);
    await saveLocalAgentEndpoint(storage, { hubId: HUB_B, key: KEY, ws: WS_B }, 10);

    await expect(
      pruneLocalAgentEndpoints(storage, {
        isConnected: hubId => hubId === HUB_B,
        now: LOCAL_AGENT_ENDPOINT_REFRESH_MS,
      })
    ).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, lastConnectedAt: 10, ws: WS_A },
      { hubId: HUB_B, key: KEY, lastConnectedAt: 10, ws: WS_B },
    ]);
    await expect(
      pruneLocalAgentEndpoints(storage, {
        isConnected: hubId => hubId === HUB_B,
        now: LOCAL_AGENT_ENDPOINT_STALE_MS + 10,
      })
    ).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, lastConnectedAt: 10, ws: WS_A },
      { hubId: HUB_B, key: KEY, lastConnectedAt: LOCAL_AGENT_ENDPOINT_STALE_MS + 10, ws: WS_B },
    ]);
  });

  it('records when a hub was reachable without bringing back a removed endpoint', async () => {
    const storage = createStorage();
    await saveLocalAgentEndpoint(storage, { hubId: HUB_A, key: KEY, ws: WS_A }, 10);

    await touchLocalAgentEndpoint(storage, HUB_A, 99);
    await touchLocalAgentEndpoint(storage, HUB_B, 99);

    await expect(loadLocalAgentEndpoints(storage)).resolves.toStrictEqual([
      { hubId: HUB_A, key: KEY, lastConnectedAt: 99, ws: WS_A },
    ]);
  });
});
