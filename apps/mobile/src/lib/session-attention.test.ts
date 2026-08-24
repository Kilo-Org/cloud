/* eslint-disable max-lines -- cohesive suite for the ack state machine, durable persistence, expiry, and hydration contracts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session-attention module lazy-loads the native encrypted-kv chain; the
// fake below is an in-memory Map-backed KV so persistence tests run in node.
const kvStore = new Map<string, string>();

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  clearScope: vi.fn(async (_scope: string): Promise<void> => undefined),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

/* eslint-disable import/first */
import { SESSION_ATTENTION_KEY } from '@/lib/storage-keys';
import {
  __flushSessionAttentionWritesForTests,
  __hydrateSessionAttentionForTests,
  __peekSessionAttentionEntryForTests,
  __peekSessionAttentionForTests,
  __resetSessionAttentionForTests,
  ackSessionAttention,
  clearSessionAttentionForSignOut,
  getRevisionSnapshot,
  isAttentionAcked,
  reconcileSessionAttention,
  SESSION_ATTENTION_EXPIRY_MS,
  sessionNeedsInput,
  shouldShowNeedsInput,
  subscribe,
} from './session-attention';
/* eslint-enable import/first */

// Matches the module's internal item key for the single entries blob.
const ATTENTION_ENTRY_KEY = 'entries';

const DAY_MS = 24 * 60 * 60 * 1000;

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

function seedAttentionKv(entries: unknown[]): void {
  kvStore.set(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY), JSON.stringify(entries));
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  __resetSessionAttentionForTests();
  kvMock.getItem.mockImplementation(async (scope, k) => kvStore.get(storageKey(scope, k)) ?? null);
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), v);
  });
  kvMock.clearScope.mockImplementation(async scope => {
    for (const key of kvStore.keys()) {
      if (key.startsWith(`${scope}\u0000`)) {
        kvStore.delete(key);
      }
    }
  });
});

afterEach(async () => {
  await __flushSessionAttentionWritesForTests();
  vi.useRealTimers();
});

describe('sessionNeedsInput', () => {
  it('returns true for question', () => {
    expect(sessionNeedsInput('question')).toBe(true);
  });

  it('returns true for permission', () => {
    expect(sessionNeedsInput('permission')).toBe(true);
  });

  it('returns false for idle', () => {
    expect(sessionNeedsInput('idle')).toBe(false);
  });

  it('returns false for busy', () => {
    expect(sessionNeedsInput('busy')).toBe(false);
  });

  it('returns false for retry', () => {
    expect(sessionNeedsInput('retry')).toBe(false);
  });

  it('returns false for null', () => {
    expect(sessionNeedsInput(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(sessionNeedsInput(undefined)).toBe(false);
  });

  it('returns false for an unknown status string', () => {
    expect(sessionNeedsInput('mystery')).toBe(false);
  });
});

describe('shouldShowNeedsInput', () => {
  it('shows when status is attention and not acked', () => {
    expect(shouldShowNeedsInput({ status: 'question', raiseId: 'R1', isAcked: false })).toBe(true);
  });

  it('hides when status is attention and acked', () => {
    expect(shouldShowNeedsInput({ status: 'question', raiseId: 'R1', isAcked: true })).toBe(false);
  });

  it('hides when status is non-attention even if not acked', () => {
    expect(shouldShowNeedsInput({ status: 'busy', raiseId: null, isAcked: false })).toBe(false);
  });

  it('hides when status is non-attention even if acked', () => {
    expect(shouldShowNeedsInput({ status: 'idle', raiseId: null, isAcked: true })).toBe(false);
  });

  it('hides when status is null', () => {
    expect(shouldShowNeedsInput({ status: null, raiseId: null, isAcked: false })).toBe(false);
  });
});

describe('ack store state machine', () => {
  it('pending ack hides the indicator immediately for any raiseId', () => {
    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s1', 'R2')).toBe(true);
    expect(isAttentionAcked('s1', null)).toBe(true);
  });

  it('reconcile resolves a pending entry to the observed raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
  });

  it('a resolved ack hides its own raise but not a new one', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    // a new status_updated_at means a new raise — should show again
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
  });

  it('a later successful answer re-pends a resolved ack and hides the new raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // new raise R2 arrives and is not acked
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
    // user answers again → ack overwrites with pending
    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R2')).toBe(true);
  });

  it('without an ack, opening alone leaves the badge visible for any raise', () => {
    // DEF-4: no on-mount ack — viewing a blocked session must not hide NEEDS INPUT
    expect(isAttentionAcked('s1', 'R1')).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('s1', 'R1'),
      })
    ).toBe(true);
  });

  it('acking one session never suppresses a raise on a different session', () => {
    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s2', 'R1')).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('s2', 'R1'),
      })
    ).toBe(true);
  });

  it('reconcile deletes the entry on a non-attention status, so the next raise shows', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R1' });

    // status drops to busy — entry should be cleared
    reconcileSessionAttention('s1', 'busy', null);
    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();

    // next question raise (no timestamp — remote active-only row)
    // is NOT acked and therefore visible
    expect(isAttentionAcked('s1', 'question')).toBe(false);
  });

  it('timestamp-less remote question → busy → question cycle re-raises visibly', () => {
    ackSessionAttention('s1');
    // resolve to status string (no statusUpdatedAt)
    reconcileSessionAttention('s1', 'question', null);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });

    // busy clears the entry
    reconcileSessionAttention('s1', 'busy', null);
    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();

    // fresh question raise — not acked, visible
    expect(isAttentionAcked('s1', 'question')).toBe(false);
  });

  it('answer-then-clear sequence: pending entry resolves via reconcile, then next raise is not absorbed', () => {
    // user answers (ack → pending), then status still reports the same raise
    ackSessionAttention('s1');
    // reconcile resolves the pending entry to R1
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);

    // new raise R2 — pending is already resolved to R1, so R2 is NOT acked
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
  });

  it('reconcile with attention status and no entry is a no-op', () => {
    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    reconcileSessionAttention('s1', 'question', 'R1');

    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', 'R1')).toBe(false);

    unsubscribe();
  });

  it('reconcile with non-attention status and no entry is a no-op (does not bump revision)', () => {
    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    reconcileSessionAttention('s1', 'busy', null);

    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('reconcile with attention status and a resolved entry is a no-op for the same raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // now entry.raiseId === 'R1'

    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    // same raiseId → still resolved, no change
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', 'R1')).toBe(true);

    unsubscribe();
  });
});

describe('entry shape and re-raise', () => {
  it('resolves a pending entry with the observed raise and ack metadata', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    const entry = __peekSessionAttentionEntryForTests('s1');
    expect(entry).toMatchObject({ raiseId: 'R1', status: 'question' });
    expect(entry?.ackedAt).toBeTypeOf('number');
    expect(entry?.expiresAt).toBe((entry?.ackedAt ?? 0) + SESSION_ATTENTION_EXPIRY_MS);
  });

  it('replaces the raise and clears the ack on a same-session re-raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);

    // a new status_updated_at is a new raise: the badge returns
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', 'R1')).toBe(false);
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
    expect(__peekSessionAttentionEntryForTests('s1')).toEqual({
      raiseId: 'R2',
      status: 'question',
      ackedAt: null,
      expiresAt: null,
    });
  });

  it('acking a re-raised entry re-pends it and hides the new raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // re-raise
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', 'R2')).toBe(false);

    // user answers the new raise
    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R2')).toBe(true);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: null });
  });
});

describe('durable persistence', () => {
  it('round-trips acks across a simulated restart', async () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();

    // Simulated restart: clear the in-memory store, then re-hydrate from KV.
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
    expect(__peekSessionAttentionEntryForTests('s1')).toEqual({
      raiseId: 'R1',
      status: 'question',
      ackedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
  });

  it('restores a pending ack as pending across a restart', async () => {
    ackSessionAttention('s1');
    await __flushSessionAttentionWritesForTests();

    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    // A pending ack hides any raise after restart.
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s1', 'R2')).toBe(true);
  });

  it('persists a deleted entry as gone across a restart', async () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // delete
    reconcileSessionAttention('s1', 'busy', null);
    await __flushSessionAttentionWritesForTests();

    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();
  });

  it('persists a write during the hydration window without erasing the hydrated entry', async () => {
    const now = Date.now();
    const persisted = JSON.stringify([
      {
        sessionId: 's1',
        raiseId: 'R1',
        status: 'question',
        ackedAt: now,
        expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
      },
    ]);

    // Hold the KV read open so the write can land mid-hydration.
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();

    // A write for a different session lands while hydration is still reading.
    ackSessionAttention('s2');

    // Release the stale persisted read.
    readGate.resolve(persisted);
    await hydration;
    await __flushSessionAttentionWritesForTests();

    // The persisted blob holds both the hydrated entry and the fresh entry.
    const stored = JSON.parse(
      kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY)) ?? '[]'
    ) as { sessionId: string }[];
    expect(stored.map(entry => entry.sessionId).toSorted()).toEqual(['s1', 's2']);
  });

  it('keeps in-memory behavior when a KV write fails and retries on the next bump', async () => {
    kvMock.setItem.mockRejectedValueOnce(new Error('disk full'));
    ackSessionAttention('s1');
    // In-memory store is authoritative: the badge hides immediately.
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    await __flushSessionAttentionWritesForTests();
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: null });

    // The next bump retries the write.
    reconcileSessionAttention('s1', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();
    expect(kvMock.setItem).toHaveBeenCalledTimes(2);
    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeDefined();
  });

  it('starts empty when hydration fails, and the in-memory store still works', async () => {
    seedAttentionKv([
      {
        sessionId: 's1',
        raiseId: 'R1',
        status: 'question',
        ackedAt: Date.now(),
        expiresAt: Date.now() + SESSION_ATTENTION_EXPIRY_MS,
      },
    ]);
    kvMock.getItem.mockRejectedValueOnce(new Error('corrupt'));
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();

    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
  });
});

describe('expiry', () => {
  it('drops expired entries at hydration', async () => {
    const now = Date.now();
    seedAttentionKv([
      {
        sessionId: 'expired',
        raiseId: 'R1',
        status: 'question',
        ackedAt: now - 8 * DAY_MS,
        expiresAt: now - DAY_MS,
      },
      {
        sessionId: 'fresh',
        raiseId: 'R2',
        status: 'permission',
        ackedAt: now,
        expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
      },
    ]);
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    expect(__peekSessionAttentionForTests('expired')).toBeUndefined();
    expect(__peekSessionAttentionForTests('fresh')).toEqual({ raiseId: 'R2' });
  });

  it('drops expired entries on reconcile', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      ackSessionAttention('s1');
      reconcileSessionAttention('s1', 'question', 'R1');
      expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R1' });

      // 9 days later the ack has expired.
      vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
      reconcileSessionAttention('s1', 'question', 'R1');
      expect(__peekSessionAttentionForTests('s1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hydration gating', () => {
  it('renders badges from server status until hydration completes', async () => {
    const now = Date.now();
    seedAttentionKv([
      {
        sessionId: 's1',
        raiseId: 'R1',
        status: 'question',
        ackedAt: now,
        expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
      },
    ]);
    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();

    // Hydration is in flight: the store is still empty, so the badge derives
    // from server status (no stale ack suppression).
    expect(isAttentionAcked('s1', 'R1')).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('s1', 'R1'),
      })
    ).toBe(true);

    await hydration;

    // After hydration the restored ack suppresses its raise.
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('s1', 'R1'),
      })
    ).toBe(false);
  });

  it('does not revert a fresh ack committed during the hydration window', async () => {
    const now = Date.now();
    const persisted = JSON.stringify([
      {
        sessionId: 's1',
        raiseId: 'R1',
        status: 'question',
        ackedAt: now,
        expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
      },
    ]);

    // Hold the KV read open so the ack can land mid-hydration.
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();

    // The fresh ack lands while hydration is still reading.
    ackSessionAttention('s1');
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: null });

    // Release the stale persisted read.
    readGate.resolve(persisted);
    await hydration;

    // The fresh ack survives: still pending, not the persisted resolved entry.
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: null });
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
  });
});

describe('revision snapshot and listener notification', () => {
  it('bumps revision and notifies listeners on ackSessionAttention', () => {
    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    ackSessionAttention('s1');

    expect(getRevisionSnapshot()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does not bump revision or notify when re-acking an already-pending entry', () => {
    ackSessionAttention('s1');

    const after = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    // Repeated successful answers while still pending is a no-op.
    ackSessionAttention('s1');
    ackSessionAttention('s1');

    expect(getRevisionSnapshot()).toBe(after);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', 'R1')).toBe(true);

    unsubscribe();
  });

  it('bumps revision when re-acking a resolved entry (re-pends it)', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // entry is now resolved to R1

    const after = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    ackSessionAttention('s1');

    expect(getRevisionSnapshot()).toBe(after + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    // re-pended: a new raise is once again absorbed
    expect(isAttentionAcked('s1', 'R2')).toBe(true);

    unsubscribe();
  });

  it('bumps revision on mutating reconciles and stays stable on no-ops', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    const initial = getRevisionSnapshot();
    let mutations = 0;

    // ack → mutation
    ackSessionAttention('s1');
    if (getRevisionSnapshot() !== initial) {
      mutations += 1;
    }

    // resolve → mutation
    reconcileSessionAttention('s1', 'question', 'R1');
    if (getRevisionSnapshot() !== initial + mutations) {
      mutations += 1;
    }

    const afterMutations = getRevisionSnapshot();

    // no-op reconciles: no entry → no change; resolved entry + same raise → no change
    reconcileSessionAttention('s2', 'busy', null);
    reconcileSessionAttention('s1', 'question', 'R1');

    expect(getRevisionSnapshot()).toBe(afterMutations);
    expect(listener).toHaveBeenCalledTimes(mutations);

    // re-raise → mutation
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(getRevisionSnapshot()).toBe(afterMutations + 1);
    expect(listener).toHaveBeenCalledTimes(mutations + 1);

    // delete → mutation
    reconcileSessionAttention('s1', 'busy', null);
    expect(getRevisionSnapshot()).toBe(afterMutations + 2);
    expect(listener).toHaveBeenCalledTimes(mutations + 2);

    unsubscribe();
  });

  it('listener notification count equals revision delta', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    const start = getRevisionSnapshot();
    ackSessionAttention('a');
    ackSessionAttention('b');
    reconcileSessionAttention('a', 'question', 'R1');
    reconcileSessionAttention('a', 'busy', null);
    // no-ops:
    reconcileSessionAttention('a', 'busy', null);
    reconcileSessionAttention('c', 'question', 'R9');
    reconcileSessionAttention('a', 'question', 'R1');
    const end = getRevisionSnapshot();

    expect(end - start).toBe(listener.mock.calls.length);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it('isolates a throwing listener so later subscribers are still notified once', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn<() => void>();
    const unsubThrowing = subscribe(throwing);
    const unsubGood = subscribe(good);

    const before = getRevisionSnapshot();
    expect(() => {
      ackSessionAttention('s1');
    }).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(getRevisionSnapshot()).toBe(before + 1);

    unsubThrowing();
    unsubGood();
  });

  it('unsubscribe stops further notifications', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    ackSessionAttention('s1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    // A real mutation on a different session would notify a live listener;
    // after unsubscribe it must not.
    ackSessionAttention('s2');
    expect(getRevisionSnapshot()).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out cleanup', () => {
  it('drops the previous account acks so a reused session id is not suppressed', async () => {
    ackSessionAttention('session-shared');
    reconcileSessionAttention('session-shared', 'question', '2026-08-24T10:00:00Z');
    await __flushSessionAttentionWritesForTests();
    expect(isAttentionAcked('session-shared', '2026-08-24T10:00:00Z')).toBe(true);

    await clearSessionAttentionForSignOut();

    // The next account hydrates from the same device: the blob is gone, so the
    // prior ack cannot suppress the badge for the same session id.
    await __hydrateSessionAttentionForTests();
    expect(__peekSessionAttentionForTests('session-shared')).toBeUndefined();
    expect(isAttentionAcked('session-shared', '2026-08-24T10:00:00Z')).toBe(false);
    expect(
      shouldShowNeedsInput({ status: 'question', raiseId: '2026-08-24T10:00:00Z', isAcked: false })
    ).toBe(true);
  });

  it('deletes the persisted blob and notifies subscribers', async () => {
    ackSessionAttention('session-a');
    await __flushSessionAttentionWritesForTests();
    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeDefined();

    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    await clearSessionAttentionForSignOut();
    unsubscribe();

    expect(kvMock.clearScope).toHaveBeenCalledWith(SESSION_ATTENTION_KEY);
    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it('is not defeated by a bump queued right before sign-out', async () => {
    ackSessionAttention('session-a');
    // No flush: the write is still queued when the clear is chained behind it.
    await clearSessionAttentionForSignOut();

    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeUndefined();
  });

  it('never throws when the encrypted KV delete fails', async () => {
    ackSessionAttention('session-a');
    await __flushSessionAttentionWritesForTests();
    kvMock.clearScope.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(clearSessionAttentionForSignOut()).resolves.toBeUndefined();
    expect(__peekSessionAttentionForTests('session-a')).toBeUndefined();
  });
});
