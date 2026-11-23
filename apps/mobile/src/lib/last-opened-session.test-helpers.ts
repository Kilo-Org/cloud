import { vi } from 'vitest';

/**
 * Shared fixtures for the last-opened-session suite: the fake SecureStore
 * surface, the record shape, a refused read, and the two flushes the suite
 * needs. Kept beside the suite so the test file stays under the line limit.
 */

export const KEY = 'last-opened-session';

export const store = new Map<string, string>();

type StoreSurface = {
  getItemAsync: {
    mockReset: () => void;
    mockImplementation: (implementation: (key: string) => Promise<string | null>) => void;
  };
  setItemAsync: {
    mockReset: () => void;
    mockImplementation: (implementation: (key: string, value: string) => Promise<void>) => void;
  };
  deleteItemAsync: {
    mockReset: () => void;
    mockImplementation: (implementation: (key: string) => Promise<void>) => void;
  };
};

/**
 * Install the default, healthy fake store: a Map-backed surface. The mock
 * functions themselves are hoisted in the suite (Vitest cannot hoist them
 * across modules), so the suite hands them in.
 */
export function installHealthyStore(mocks: StoreSurface): void {
  store.clear();
  // Reset first so one test's call history and queued one-time implementations
  // never reach the next.
  for (const mock of [mocks.getItemAsync, mocks.setItemAsync, mocks.deleteItemAsync]) {
    mock.mockReset();
  }
  mocks.getItemAsync.mockImplementation(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  });
  mocks.setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  });
  mocks.deleteItemAsync.mockImplementation(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  });
}

export function recordFor(sessionId: string, userId: string): string {
  return JSON.stringify({ sessionId, userId, storedAt: 1_700_000_000_000 });
}

/** A read that rejects, built without `Promise.reject` so the promise rule
 *  stays satisfied. */
// eslint-disable-next-line require-await -- an async throw is the rejected promise under test
export async function refusedRead(message: string): Promise<string | null> {
  throw new Error(message);
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    promise,
    resolve: () => {
      resolve(undefined);
    },
  };
}

/**
 * Let the serialized SecureStore mirror drain and the retry cadence land: the
 * mock operations settle in microtasks, and the retry backoff is a timer.
 */
export async function flushMirror(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

/** Run the whole retry budget (250 + 500 + 1000 ms plus the reads between). */
export async function flushRetryBudget(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
}
