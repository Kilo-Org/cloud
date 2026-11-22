import { vi } from 'vitest';

/**
 * Shared fixtures for the last-opened-session suite: the record shape, a
 * refused read, and the two flushes the suite needs. Kept beside the suite so
 * the test file stays under the line limit, and free of the module under test
 * so nothing here is hoisted with its mocks.
 */

export const KEY = 'last-opened-session';

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
