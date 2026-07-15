import { describe, expect, it, vi } from 'vitest';

import {
  createLocalSessionRequestIdStore,
  type LocalSessionRequestIdStore,
  type RequestIdUuid,
} from './local-session-request-id';

const FENCE_A = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
} as const;
const FENCE_A_NEW_SOCKET = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a-new',
} as const;
const FENCE_B = {
  runtimeId: '22222222-2222-4222-8222-222222222222',
  connectionId: 'cli-b',
} as const;

function makeUuidFactory(values: string[]): () => RequestIdUuid {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error(`UUID factory exhausted at call #${index}`);
    }
    return value as RequestIdUuid;
  };
}

const REQUEST_ID_1: RequestIdUuid = '00000000-0000-4000-8000-000000000001' as RequestIdUuid;
const REQUEST_ID_2: RequestIdUuid = '00000000-0000-4000-8000-000000000002' as RequestIdUuid;
const REQUEST_ID_3: RequestIdUuid = '00000000-0000-4000-8000-000000000003' as RequestIdUuid;

describe('createLocalSessionRequestIdStore', () => {
  it('lazily allocates a fresh UUID on the first acquire for a given fence', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });

    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('allocates a fresh UUID when the runtimeId changes', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });

    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(store.getOrAcquire(FENCE_B)).toBe(REQUEST_ID_2);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it('clears the requestId when the connectionId changes (reconnect) and reallocates on next acquire', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });

    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(store.getOrAcquire(FENCE_A_NEW_SOCKET)).toBe(REQUEST_ID_2);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it('clearByFence removes the requestId for the exact fence without touching other fences', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2, REQUEST_ID_3]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });

    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(store.getOrAcquire(FENCE_B)).toBe(REQUEST_ID_2);
    store.clearByFence(FENCE_A);
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_3);
    expect(store.getOrAcquire(FENCE_B)).toBe(REQUEST_ID_2);
  });

  it('clearAll wipes every fence and forces fresh allocations on next acquire', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2, REQUEST_ID_3]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });

    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    expect(store.getOrAcquire(FENCE_B)).toBe(REQUEST_ID_2);
    store.clearAll();
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_3);
  });

  it('returns the current requestId without allocating a new UUID when one is already bound', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });
    const first = store.getOrAcquire(FENCE_A);
    const second = store.getOrAcquire(FENCE_A);
    expect(first).toBe(second);
    expect(first).toBe(REQUEST_ID_1);
  });

  it('a "success" clear for the fence removes the requestId so the next attempt starts fresh', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    store.markSuccess(FENCE_A);
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_2);
  });

  it('only allocates through the injected generateUuid — no built-in fallback to Crypto.randomUUID', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });
    store.getOrAcquire(FENCE_A);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('does not retain a requestId for a fence that was never acquired', () => {
    const gen = vi.fn(() => REQUEST_ID_1);
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });
    store.clearByFence(FENCE_A);
    store.clearAll();
    expect(gen).not.toHaveBeenCalled();
  });

  it('clearByFence for a fence with a different connectionId does not wipe the original entry', () => {
    const gen = vi.fn(makeUuidFactory([REQUEST_ID_1, REQUEST_ID_2]));
    const store = createLocalSessionRequestIdStore({ generateUuid: gen });
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
    store.clearByFence({ runtimeId: FENCE_A.runtimeId, connectionId: 'stale' });
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
  });

  it('exposes a typed store via the factory contract', () => {
    const store: LocalSessionRequestIdStore = createLocalSessionRequestIdStore({
      generateUuid: makeUuidFactory([REQUEST_ID_1]),
    });
    expect(store.getOrAcquire(FENCE_A)).toBe(REQUEST_ID_1);
  });
});
