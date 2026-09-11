/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore fakes settle without await because they resolve immediately, and the latch test's fake returns a never-settling promise; mirroring use-new-session-creator.test.ts */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Sentry from '@sentry/react-native';

// The decision record is a SecureStore entry (the per-account consent
// pattern), so the test replays it through an in-memory map with the same
// contract: an absent key reads null, `setItemAsync` commits before it
// resolves, and a failing native call rejects.
const secureStore = vi.hoisted(() => {
  const store = new Map<string, string>();
  let failNextWrites = 0;
  return {
    store,
    failNextWrites(n: number) {
      failNextWrites = n;
    },
    getItemAsync: vi.fn(async (key: string) => {
      await Promise.resolve();
      return store.get(key) ?? null;
    }),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      await Promise.resolve();
      if (failNextWrites > 0) {
        failNextWrites -= 1;
        throw new Error('keystore unavailable');
      }
      store.set(key, value);
    }),
  };
});

vi.mock('expo-secure-store', () => secureStore);

// The Sentry bridge pulls in the native SDK the node test env cannot load.
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import { FIRST_RUN_TOUR_KEY_PREFIX } from '@/lib/storage-keys';
import {
  firstRunTourStorageKey,
  isFirstRunTourStatus,
  loadFirstRunTourDecision,
  markFirstRunTourStatus,
  parseFirstRunTourRecord,
} from './index';
// The outcome latch is a leaf export (the gate imports it directly); the
// barrel stays minimal, so this test reads it from the leaf too.
import { hasRecordedFirstRunTourOutcome } from './tour-state';
/* eslint-enable import/first */

// Hex-encoded "u1" is "7531".
const U1_KEY = `${FIRST_RUN_TOUR_KEY_PREFIX}7531`;

beforeEach(() => {
  vi.clearAllMocks();
  secureStore.store.clear();
  secureStore.failNextWrites(0);
});

describe('firstRunTourStorageKey', () => {
  it('is the per-account SecureStore key, same class as the consent records', () => {
    expect(firstRunTourStorageKey('u1')).toBe(U1_KEY);
    expect(firstRunTourStorageKey('u1')).not.toBe(firstRunTourStorageKey('u2'));
  });
});

describe('isFirstRunTourStatus / parseFirstRunTourRecord', () => {
  it('accepts both terminal statuses', () => {
    expect(isFirstRunTourStatus('done')).toBe(true);
    expect(isFirstRunTourStatus('skipped')).toBe(true);
    expect(parseFirstRunTourRecord('skipped')).toEqual({ status: 'skipped' });
  });

  it('reads anything else as null (eligible)', () => {
    expect(isFirstRunTourStatus('pending')).toBe(false);
    expect(isFirstRunTourStatus('')).toBe(false);
    expect(parseFirstRunTourRecord(null)).toBeNull();
    expect(parseFirstRunTourRecord('garbage')).toBeNull();
    expect(parseFirstRunTourRecord('{"status":"done"}')).toBeNull();
  });
});

describe('loadFirstRunTourDecision', () => {
  it('is null when no record is stored (eligible)', async () => {
    expect(await loadFirstRunTourDecision('u1')).toBeNull();
  });

  it('returns the decision when the stored record is a status', async () => {
    secureStore.store.set(U1_KEY, 'skipped');
    expect(await loadFirstRunTourDecision('u1')).toEqual({ status: 'skipped' });
  });

  it('is null when the stored record is corrupt', async () => {
    secureStore.store.set(U1_KEY, 'not-a-status');
    expect(await loadFirstRunTourDecision('u1')).toBeNull();
  });

  it('is null and reported when the native read throws', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
    expect(await loadFirstRunTourDecision('u1')).toBeNull();
    // Fail-open but never silent: the loss re-opens a dismissed tour.
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('is null for an empty user id without touching the store', async () => {
    expect(await loadFirstRunTourDecision('')).toBeNull();
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
  });
});

describe('markFirstRunTourStatus', () => {
  it('stores the status under the account key and confirms it landed', async () => {
    await markFirstRunTourStatus('u1', 'skipped');
    expect(secureStore.store.get(U1_KEY)).toBe('skipped');
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    // Confirmed by a read-back, not by the write resolving.
    expect(secureStore.getItemAsync).toHaveBeenCalled();
  });

  it('records done and skipped distinctly', async () => {
    await markFirstRunTourStatus('u1', 'done');
    expect(await loadFirstRunTourDecision('u1')).toEqual({ status: 'done' });
  });

  it('re-issues the write until it lands when the native write fails', async () => {
    vi.useFakeTimers();
    try {
      secureStore.failNextWrites(2);
      const marking = markFirstRunTourStatus('u1', 'skipped');
      await vi.runAllTimersAsync();
      await marking;
      expect(secureStore.store.get(U1_KEY)).toBe('skipped');
      expect(secureStore.setItemAsync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops re-issuing once ANY decision is stored, never overwriting a later one', async () => {
    // A failing 'skipped' mark must not clobber a 'done' that a later tour
    // run recorded: the confirm read runs BEFORE every re-issue, and any
    // stored decision ends the loop.
    vi.useFakeTimers();
    try {
      secureStore.store.set(U1_KEY, 'done');
      secureStore.failNextWrites(1);
      const marking = markFirstRunTourStatus('u1', 'skipped');
      await vi.runAllTimersAsync();
      await marking;
      expect(secureStore.store.get(U1_KEY)).toBe('done');
      // The failed first write threw; the confirm found the later decision
      // and stopped before any re-issue could overwrite it.
      expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the retry budget without throwing (fail-open stands)', async () => {
    vi.useFakeTimers();
    try {
      secureStore.failNextWrites(99);
      const marking = markFirstRunTourStatus('u1', 'skipped');
      await vi.runAllTimersAsync();
      await expect(marking).resolves.toBeUndefined();
      expect(secureStore.store.get(U1_KEY)).toBeUndefined();
      // One initial attempt plus one re-issue per backoff step.
      expect(secureStore.setItemAsync).toHaveBeenCalledTimes(6);
      // The latch still holds: this process will not re-open the tour.
      expect(hasRecordedFirstRunTourOutcome('u1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an empty user id but still latches nothing', async () => {
    await markFirstRunTourStatus('', 'skipped');
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(hasRecordedFirstRunTourOutcome('')).toBe(true);
  });
});

describe('hasRecordedFirstRunTourOutcome', () => {
  it('is false for an account that never recorded an outcome', () => {
    expect(hasRecordedFirstRunTourOutcome('u-unmarked')).toBe(false);
  });

  it('latches synchronously, before the awaited write resolves', () => {
    // The back guard dismisses without awaiting the mark: the gate must see
    // the outcome the moment the mark is CALLED, or a read racing the
    // in-flight write re-opens the tour the person just dismissed.
    secureStore.setItemAsync.mockImplementationOnce(
      async () =>
        new Promise<void>(resolve => {
          // Deliberately never resolved; `resolve` is referenced so the
          // executor is a real body, not an empty function.
          void resolve;
        })
    );
    const marking = markFirstRunTourStatus('u-latch', 'skipped');
    expect(hasRecordedFirstRunTourOutcome('u-latch')).toBe(true);
    // The latched read above happened before the write resolved; the pending
    // mark is intentionally dropped (it never settles in this test).
    void marking;
  });

  it('is scoped per account', async () => {
    await markFirstRunTourStatus('u-marked', 'skipped');
    expect(hasRecordedFirstRunTourOutcome('u-marked')).toBe(true);
    expect(hasRecordedFirstRunTourOutcome('u-marked-other')).toBe(false);
  });
});
