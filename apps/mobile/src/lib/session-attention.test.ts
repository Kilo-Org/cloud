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
  getHydrationSnapshot,
  getRevisionSnapshot,
  isAttentionAcked,
  needsInputVisibility,
  reconcileSessionAttention,
  SESSION_ATTENTION_EXPIRY_MS,
  sessionNeedsInput,
  shouldShowNeedsInput,
  subscribe,
  whenSessionAttentionHydrationSettled,
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
    expect(shouldShowNeedsInput({ status: 'question', hydration: 'ready', isAcked: false })).toBe(
      true
    );
  });

  it('hides when status is attention and acked', () => {
    expect(shouldShowNeedsInput({ status: 'question', hydration: 'ready', isAcked: true })).toBe(
      false
    );
  });

  it('hides when status is non-attention even if not acked', () => {
    expect(shouldShowNeedsInput({ status: 'busy', hydration: 'ready', isAcked: false })).toBe(
      false
    );
  });

  it('hides when status is non-attention even if acked', () => {
    expect(shouldShowNeedsInput({ status: 'idle', hydration: 'ready', isAcked: true })).toBe(false);
  });

  it('hides when status is null', () => {
    expect(shouldShowNeedsInput({ status: null, hydration: 'ready', isAcked: false })).toBe(false);
  });
});

describe('ack store state machine', () => {
  it('an ack hides only the raise it names', () => {
    ackSessionAttention('s1', 'question', 'R1');

    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R1' });
  });

  it('an ack with no timestamp hides the raise it was answered from', () => {
    ackSessionAttention('s1', 'question');

    // The caller named the status the user answered, nothing more.
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
  });

  it('a different raise observed after an ack keeps its own badge', () => {
    // The user answered a question; a permission the user has not seen arrives
    // before the answer's status round-trip lands.
    ackSessionAttention('s1', 'question', 'R1');

    reconcileSessionAttention('s1', 'permission', 'R2');

    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'permission',
        hydration: 'ready',
        isAcked: isAttentionAcked('s1', { raiseId: 'R2' }),
      })
    ).toBe(true);
    expect(__peekSessionAttentionEntryForTests('s1')).toEqual({
      raiseId: 'R2',
      status: 'permission',
      ackedAt: null,
      expiresAt: null,
    });
  });

  it('a re-raise of the acked status after an ack keeps its own badge', () => {
    ackSessionAttention('s1', 'permission', 'R1');

    reconcileSessionAttention('s1', 'permission', 'R2');

    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
  });

  it('a status-only ack learns its raise on the first observation, then a later raise shows', () => {
    ackSessionAttention('s1', 'permission');

    // The raise the user answered, observed for the first time.
    reconcileSessionAttention('s1', 'permission', 'R1');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    // A new permission under the same status.
    reconcileSessionAttention('s1', 'permission', 'R2');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
  });

  it('a same-status re-raise shows on a reader that knows the row time', () => {
    ackSessionAttention('s1', 'permission', 'R1');

    // The Agents rows read the row they render: its status and its status time.
    expect(isAttentionAcked('s1', { raiseId: 'R1', status: 'permission' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R2', status: 'permission' })).toBe(false);
    // A row the surface cannot date still reads the acked status.
    expect(isAttentionAcked('s1', { raiseId: 'permission' })).toBe(true);
  });

  it('a status-only ack answers a dated raise it can order, not one after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    ackSessionAttention('s1', 'permission');

    // A raise dated before the answer is the one the person answered.
    expect(
      isAttentionAcked('s1', { raiseId: '2026-10-12T09:59:30.000Z', status: 'permission' })
    ).toBe(true);
    // A raise after it is a new raise, whichever status it carries.
    expect(
      isAttentionAcked('s1', { raiseId: '2026-10-12T10:00:30.000Z', status: 'permission' })
    ).toBe(false);
    expect(
      isAttentionAcked('s1', { raiseId: '2026-10-12T10:00:30.000Z', status: 'question' })
    ).toBe(false);
  });

  it('a dated raise observed after a status-only ack shows its badge', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    const earlier = '2026-10-12T09:59:30.000Z';
    const later = '2026-10-12T10:00:30.000Z';
    ackSessionAttention('s1', 'permission');
    expect(isAttentionAcked('s1', { raiseId: earlier, status: 'permission' })).toBe(true);

    /* The stored row arrives with its own status time: the raise it names is
       newer than the answer, so it is a raise the person has not answered. */
    reconcileSessionAttention('s1', 'permission', later);

    expect(isAttentionAcked('s1', { raiseId: later, status: 'permission' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'permission',
        hydration: 'ready',
        isAcked: isAttentionAcked('s1', { raiseId: later, status: 'permission' }),
      })
    ).toBe(true);
  });

  it('a different status dated before a status-only ack is not answered by it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    ackSessionAttention('s1', 'permission');

    /* A question raised before the permission was answered is a different raise:
       the answer names a permission, so nothing about it answers a question. */
    expect(
      isAttentionAcked('s1', { raiseId: '2026-10-12T09:59:30.000Z', status: 'question' })
    ).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: 'ready',
        isAcked: isAttentionAcked('s1', {
          raiseId: '2026-10-12T09:59:30.000Z',
          status: 'question',
        }),
      })
    ).toBe(true);
  });

  it('does not reuse a raise that was already answered', () => {
    ackSessionAttention('s1', 'question', 'R1');

    // A question the store has not observed yet; the answer names only the
    // status, and the acked raise is not the one the user answered.
    ackSessionAttention('s1', 'question');

    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });
  });

  it('an observation without a timestamp keeps the acked status hidden', () => {
    ackSessionAttention('s1', 'permission', 'R1');

    // The tray badge reads a row without its status time.
    reconcileSessionAttention('s1', 'permission', null);

    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R1' });
    expect(isAttentionAcked('s1', { raiseId: 'permission' })).toBe(true);
  });

  it('reads a stored row PostgreSQL time and a live row ISO time as one raise', () => {
    ackSessionAttention('s1', 'permission', '2026-10-12T09:45:12.945Z');

    reconcileSessionAttention('s1', 'permission', '2026-10-12 09:45:12.945+00');

    expect(isAttentionAcked('s1', { raiseId: '2026-10-12T09:45:12.945Z' })).toBe(true);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: '2026-10-12T09:45:12.945Z' });
  });

  it('a later successful answer acks the raise the user answered', () => {
    ackSessionAttention('s1', 'question', 'R1');
    // A new raise arrives and is not acked.
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);

    ackSessionAttention('s1', 'question', 'R2');

    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
  });

  it('an ack with no timestamp keeps the raise the store already tracks for its status', () => {
    // R2 is the current raise the store observed; the in-app answer names only
    // the status, so the ack keeps the raised identity the store holds.
    ackSessionAttention('s1', 'question', 'R1');
    reconcileSessionAttention('s1', 'question', 'R2');

    ackSessionAttention('s1', 'question');

    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R2' });
    reconcileSessionAttention('s1', 'question', 'R3');
    expect(isAttentionAcked('s1', { raiseId: 'R3' })).toBe(false);
  });

  it('without an ack, opening alone leaves the badge visible for any raise', () => {
    // DEF-4: no on-mount ack — viewing a blocked session must not hide NEEDS INPUT
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: 'ready',
        isAcked: isAttentionAcked('s1', { raiseId: 'R1' }),
      })
    ).toBe(true);
  });

  it('acking one session never suppresses a raise on a different session', () => {
    ackSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(isAttentionAcked('s2', { raiseId: 'R1' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: 'ready',
        isAcked: isAttentionAcked('s2', { raiseId: 'R1' }),
      })
    ).toBe(true);
  });

  it('reconcile deletes the entry on a non-attention status, so the next raise shows', () => {
    ackSessionAttention('s1', 'question', 'R1');
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R1' });

    // status drops to busy — entry should be cleared
    reconcileSessionAttention('s1', 'busy', null);
    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();

    // next question raise (no timestamp — remote active-only row)
    // is NOT acked and therefore visible
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(false);
  });

  it('timestamp-less remote question → busy → question cycle re-raises visibly', () => {
    ackSessionAttention('s1', 'question');
    // The same status with no timestamp is the raise the user answered.
    reconcileSessionAttention('s1', 'question', null);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });

    // busy clears the entry
    reconcileSessionAttention('s1', 'busy', null);
    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();

    // fresh question raise — not acked, visible
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(false);
  });

  it('answer-then-clear sequence: the ack names its raise, so the next raise is not absorbed', () => {
    ackSessionAttention('s1', 'question', 'R1');
    // Server status still reports the same raise.
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    // new raise R2 — the ack names R1, so R2 is NOT acked
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
  });

  it('reconcile with attention status and no entry is a no-op', () => {
    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    reconcileSessionAttention('s1', 'question', 'R1');

    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);

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
    ackSessionAttention('s1', 'question', 'R1');

    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    // same raiseId → no change
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    unsubscribe();
  });
});

describe('entry shape and re-raise', () => {
  it('an ack without a timestamp learns its raise and keeps its ack metadata', () => {
    ackSessionAttention('s1', 'question');
    reconcileSessionAttention('s1', 'question', 'R1');
    const entry = __peekSessionAttentionEntryForTests('s1');
    expect(entry).toMatchObject({ raiseId: 'R1', status: 'question' });
    expect(entry?.ackedAt).toBeTypeOf('number');
    expect(entry?.expiresAt).toBe((entry?.ackedAt ?? 0) + SESSION_ATTENTION_EXPIRY_MS);
  });

  it('replaces the raise and clears the ack on a same-session re-raise', () => {
    ackSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    // a new status_updated_at is a new raise: the badge returns
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
    expect(__peekSessionAttentionEntryForTests('s1')).toEqual({
      raiseId: 'R2',
      status: 'question',
      ackedAt: null,
      expiresAt: null,
    });
  });

  it('acking a re-raised entry acks the new raise, not the old one', () => {
    ackSessionAttention('s1', 'question', 'R1');
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);

    ackSessionAttention('s1', 'question', 'R2');
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R2' });
  });
});

describe('durable persistence', () => {
  it('round-trips acks across a simulated restart', async () => {
    ackSessionAttention('s1', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();

    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
    expect(__peekSessionAttentionEntryForTests('s1')).toEqual({
      raiseId: 'R1',
      status: 'question',
      ackedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
  });

  it('a different raise observed after a restart keeps its badge', async () => {
    ackSessionAttention('s1', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();

    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    // A raise that arrived while the app was dead: the restored ack names R1,
    // so R2 is not suppressed.
    reconcileSessionAttention('s1', 'question', 'R2');

    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(false);
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'R2' });
  });

  it('drops a restored ack that names no raise', async () => {
    const now = Date.now();
    seedAttentionKv([
      { sessionId: 's1', raiseId: null, status: null, ackedAt: now, expiresAt: now + DAY_MS },
    ]);

    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();

    // An unbound ack suppresses nothing: the raise stays visible.
    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(false);
  });

  it('persists a deleted entry as gone across a restart', async () => {
    ackSessionAttention('s1', 'question', 'R1');
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
    ackSessionAttention('s2', 'question');

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
    ackSessionAttention('s1', 'question');
    // In-memory store is authoritative: the badge hides immediately.
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(true);
    await __flushSessionAttentionWritesForTests();
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });

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

    ackSessionAttention('s1', 'question', 'R1');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
  });

  it('a rejected read followed by an ack keeps the prior stored rows', async () => {
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
    kvMock.getItem.mockRejectedValueOnce(new Error('corrupt'));
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();
    expect(getHydrationSnapshot()).toBe('failed');

    ackSessionAttention('s2', 'question', 'R2');
    await __flushSessionAttentionWritesForTests();

    // The blob was never merged, so the ack must not replace it: s1's stored
    // ack survives to the next launch, and s2's answer answers in memory for
    // this run only.
    const stored = JSON.parse(
      kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY)) ?? '[]'
    ) as { sessionId: string }[];
    expect(stored.map(entry => entry.sessionId)).toEqual(['s1']);
    expect(isAttentionAcked('s2', { raiseId: 'R2' })).toBe(true);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('an ack after an unparsable blob still persists', async () => {
    // A blob whose data cannot be read holds no rows to protect, so the map
    // may replace it.
    kvStore.set(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY), '{not json');
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();
    expect(getHydrationSnapshot()).toBe('failed');

    ackSessionAttention('s1', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();

    const stored = JSON.parse(
      kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY)) ?? '[]'
    ) as unknown[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(expect.objectContaining({ sessionId: 's1' }));
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
      ackSessionAttention('s1', 'question', 'R1');
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
  it('holds the badge until hydration settles, then applies the restored ack', async () => {
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

    // Hydration is in flight: the store answers "not acked" for every raise, so
    // the phase — not that answer — decides the affordance.
    expect(getHydrationSnapshot()).toBe('loading');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: getHydrationSnapshot(),
        isAcked: isAttentionAcked('s1', { raiseId: 'R1' }),
      })
    ).toBe(false);

    await hydration;

    // After hydration the restored ack suppresses its raise.
    expect(getHydrationSnapshot()).toBe('ready');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: getHydrationSnapshot(),
        isAcked: isAttentionAcked('s1', { raiseId: 'R1' }),
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
    ackSessionAttention('s1', 'question');
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });

    // Release the stale persisted read.
    readGate.resolve(persisted);
    await hydration;

    // The fresh ack survives: still its own raise, not the persisted entry.
    expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: 'question' });
    expect(isAttentionAcked('s1', { raiseId: 'question' })).toBe(true);
  });

  it('holds the affordance while the read is gated, then settles to ready', async () => {
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();

    // The store has not read anything yet, so it cannot answer for an ack: the
    // phase says so instead of letting the empty map draw a badge.
    expect(getHydrationSnapshot()).toBe('loading');
    expect(needsInputVisibility({ status: 'question', hydration: 'loading', isAcked: false })).toBe(
      'hold'
    );
    expect(shouldShowNeedsInput({ status: 'question', hydration: 'loading', isAcked: false })).toBe(
      false
    );

    readGate.resolve(null);
    await hydration;

    expect(getHydrationSnapshot()).toBe('ready');
  });

  it('settles ready and hides only the acked raise after a successful hydration', async () => {
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
    await __hydrateSessionAttentionForTests();

    const hydration = getHydrationSnapshot();
    expect(hydration).toBe('ready');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(
      needsInputVisibility({
        status: 'question',
        hydration,
        isAcked: isAttentionAcked('s1', { raiseId: 'R1' }),
      })
    ).toBe('hide');
    expect(
      needsInputVisibility({
        status: 'question',
        hydration,
        isAcked: isAttentionAcked('s1', { raiseId: 'R2' }),
      })
    ).toBe('show');
  });

  it('settles failed, not hanging, when the KV read rejects and fails open', async () => {
    kvMock.getItem.mockRejectedValueOnce(new Error('corrupt'));
    __resetSessionAttentionForTests();

    await expect(__hydrateSessionAttentionForTests()).resolves.toBeUndefined();

    const hydration = getHydrationSnapshot();
    expect(hydration).toBe('failed');
    // No ack: the badge derives from the server status alone, for an ack the
    // failed read lost as much as for one it never held.
    for (const status of ['question', 'permission'] as const) {
      expect(needsInputVisibility({ status, hydration, isAcked: false })).toBe('show');
    }
    for (const status of ['busy', null] as const) {
      expect(needsInputVisibility({ status, hydration, isAcked: false })).toBe('hide');
    }
    // An ack this run recorded still hides its raise: the entry map is
    // authoritative for what the process has learned, and the phase never
    // leaves `failed`, so ignoring it would keep the badge for the whole launch.
    expect(needsInputVisibility({ status: 'question', hydration, isAcked: true })).toBe('hide');
    expect(needsInputVisibility({ status: 'permission', hydration, isAcked: true })).toBe('hide');
  });

  it('hides a raise acked after a failed hydration, for the rest of the launch', async () => {
    kvMock.getItem.mockRejectedValueOnce(new Error('corrupt'));
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();
    expect(getHydrationSnapshot()).toBe('failed');

    ackSessionAttention('s1', 'question', 'R1');

    // The phase is settled and never retried, so the in-memory ack is the only
    // answer available; it must suppress the raise exactly as it does at ready.
    expect(getHydrationSnapshot()).toBe('failed');
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);
    expect(
      needsInputVisibility({
        status: 'question',
        hydration: getHydrationSnapshot(),
        isAcked: isAttentionAcked('s1', { raiseId: 'R1' }),
      })
    ).toBe('hide');
  });

  it.each([
    // Neither JSON at all, nor the entry list this build reads.
    ['not JSON', '{not json'],
    ['not the entry list', JSON.stringify({ SessionId: 's1' })],
  ])('settles failed when the stored blob is %s', async (_case, blob) => {
    kvStore.set(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY), blob);
    __resetSessionAttentionForTests();

    await expect(__hydrateSessionAttentionForTests()).resolves.toBeUndefined();

    const hydration = getHydrationSnapshot();
    expect(hydration).toBe('failed');
    expect(needsInputVisibility({ status: 'question', hydration, isAcked: false })).toBe('show');
    // A raise acked this run stays hidden even though the restored blob was
    // unreadable: the in-memory entry is the only ack answer this launch has.
    expect(needsInputVisibility({ status: 'question', hydration, isAcked: true })).toBe('hide');
    expect(needsInputVisibility({ status: 'busy', hydration, isAcked: false })).toBe('hide');
  });

  it('notifies subscribers exactly once when hydration settles with restored acks', async () => {
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
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    const before = getRevisionSnapshot();

    readGate.resolve(persisted);
    await hydration;
    unsubscribe();

    // Applying the entries and settling to `ready` is one transition: one bump.
    expect(getRevisionSnapshot()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getHydrationSnapshot()).toBe('ready');
  });

  it('leaves hydration ready and the entries empty after sign-out', async () => {
    ackSessionAttention('session-a', 'question', 'R1');
    await __flushSessionAttentionWritesForTests();
    __resetSessionAttentionForTests();
    await __hydrateSessionAttentionForTests();
    expect(getHydrationSnapshot()).toBe('ready');
    expect(isAttentionAcked('session-a', { raiseId: 'R1' })).toBe(true);

    await clearSessionAttentionForSignOut();

    // Authoritatively empty for the next account, and settled: nothing re-runs
    // hydrate, so returning to `loading` would hold every badge forever.
    expect(getHydrationSnapshot()).toBe('ready');
    expect(__peekSessionAttentionForTests('session-a')).toBeUndefined();
    expect(
      needsInputVisibility({
        status: 'question',
        hydration: getHydrationSnapshot(),
        isAcked: false,
      })
    ).toBe('show');
  });

  it('a settle wait ends at its deadline while the read is gated, and at once afterwards', async () => {
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();

    await whenSessionAttentionHydrationSettled(20);

    // The deadline ended the wait; the wait itself never changes the phase.
    expect(getHydrationSnapshot()).toBe('loading');

    readGate.resolve(null);
    await hydration;

    // Settled, so the next caller does not wait at all: a 60 s deadline would
    // outlive this test's timeout if the wait ignored the settled phase.
    await whenSessionAttentionHydrationSettled(60_000);
    expect(getHydrationSnapshot()).toBe('ready');
  });

  it('a test reset ends a settle wait an earlier case armed', async () => {
    const readGate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(readGate.promise);

    __resetSessionAttentionForTests();
    const abandoned = __hydrateSessionAttentionForTests();

    // A deadline far past this case's own timeout: the wait can only end
    // because the reset releases it.
    const wait = whenSessionAttentionHydrationSettled(60_000);
    __resetSessionAttentionForTests();
    await expect(wait).resolves.toBeUndefined();

    // The abandoned read still settles, and the reset it follows owns the store
    // again, so the next case starts pre-hydration.
    readGate.resolve(null);
    await abandoned;
    __resetSessionAttentionForTests();
    expect(getHydrationSnapshot()).toBe('loading');
  });
});

describe('revision snapshot and listener notification', () => {
  it('bumps revision and notifies listeners on ackSessionAttention', () => {
    const before = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    ackSessionAttention('s1', 'question', 'R1');

    expect(getRevisionSnapshot()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does not bump revision or notify when re-acking the same raise', () => {
    ackSessionAttention('s1', 'question', 'R1');

    const after = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    // Repeated successful answers for the same raise are a no-op.
    ackSessionAttention('s1', 'question', 'R1');
    ackSessionAttention('s1', 'question', 'R1');

    expect(getRevisionSnapshot()).toBe(after);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(true);

    unsubscribe();
  });

  it('bumps revision when acking a different raise than the one already acked', () => {
    ackSessionAttention('s1', 'question', 'R1');

    const after = getRevisionSnapshot();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    ackSessionAttention('s1', 'question', 'R2');

    expect(getRevisionSnapshot()).toBe(after + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    // The ack moved to R2; R1 is no longer suppressed.
    expect(isAttentionAcked('s1', { raiseId: 'R2' })).toBe(true);
    expect(isAttentionAcked('s1', { raiseId: 'R1' })).toBe(false);

    unsubscribe();
  });

  it.each([true, false])(
    'keeps the newer raise with acked=%s when an earlier response finishes late',
    newerAcked => {
      const earlier = '2026-10-12 09:45:12.945+00';
      const newer = '2026-10-12T09:46:00.000Z';
      ackSessionAttention('s1', 'question', earlier);
      reconcileSessionAttention('s1', 'question', newer);
      if (newerAcked) {
        ackSessionAttention('s1', 'question', newer);
      }

      ackSessionAttention('s1', 'question', earlier);

      expect(__peekSessionAttentionForTests('s1')).toEqual({ raiseId: newer });
      expect(isAttentionAcked('s1', { raiseId: newer, status: 'question' })).toBe(newerAcked);
      expect(isAttentionAcked('s1', { raiseId: earlier, status: 'question' })).toBe(false);
    }
  );

  it('bumps revision on mutating reconciles and stays stable on no-ops', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    const start = getRevisionSnapshot();

    // ack → mutation
    ackSessionAttention('s1', 'question', 'R1');
    expect(getRevisionSnapshot()).toBe(start + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // the same raise observed → no-op
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(getRevisionSnapshot()).toBe(start + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // no entry → no-op; same raise again → no-op
    reconcileSessionAttention('s2', 'busy', null);
    reconcileSessionAttention('s1', 'question', 'R1');
    expect(getRevisionSnapshot()).toBe(start + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // re-raise → mutation
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(getRevisionSnapshot()).toBe(start + 2);
    expect(listener).toHaveBeenCalledTimes(2);

    // delete → mutation
    reconcileSessionAttention('s1', 'busy', null);
    expect(getRevisionSnapshot()).toBe(start + 3);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });

  it('listener notification count equals revision delta', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);

    const start = getRevisionSnapshot();
    ackSessionAttention('a', 'question');
    ackSessionAttention('b', 'question');
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
      ackSessionAttention('s1', 'question', 'R1');
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

    ackSessionAttention('s1', 'question', 'R1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    // A real mutation on a different session would notify a live listener;
    // after unsubscribe it must not.
    ackSessionAttention('s2', 'question', 'R1');
    expect(getRevisionSnapshot()).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out cleanup', () => {
  it('drops the previous account acks so a reused session id is not suppressed', async () => {
    ackSessionAttention('session-shared', 'question', '2026-08-24T10:00:00Z');
    await __flushSessionAttentionWritesForTests();
    expect(isAttentionAcked('session-shared', { raiseId: '2026-08-24T10:00:00Z' })).toBe(true);

    await clearSessionAttentionForSignOut();

    // The next account hydrates from the same device: the blob is gone, so the
    // prior ack cannot suppress the badge for the same session id.
    await __hydrateSessionAttentionForTests();
    expect(__peekSessionAttentionForTests('session-shared')).toBeUndefined();
    expect(isAttentionAcked('session-shared', { raiseId: '2026-08-24T10:00:00Z' })).toBe(false);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        hydration: getHydrationSnapshot(),
        isAcked: false,
      })
    ).toBe(true);
  });

  it('deletes the persisted blob and notifies subscribers', async () => {
    ackSessionAttention('session-a', 'question');
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
    ackSessionAttention('session-a', 'question');
    // No flush: the write is still queued when the clear is chained behind it.
    await clearSessionAttentionForSignOut();

    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeUndefined();
  });

  it('never throws when the encrypted KV delete fails', async () => {
    ackSessionAttention('session-a', 'question');
    await __flushSessionAttentionWritesForTests();
    kvMock.clearScope.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(clearSessionAttentionForSignOut()).resolves.toBeUndefined();
    expect(__peekSessionAttentionForTests('session-a')).toBeUndefined();
  });

  it('a deferred read resolved after sign-out leaves the store and the KV empty', async () => {
    const now = Date.now();
    const readGate = Promise.withResolvers<string | null>();
    const readIssued = Promise.withResolvers<undefined>();
    kvMock.getItem.mockImplementationOnce(async () => {
      // Signalled synchronously when the read is issued, so the clear below
      // runs with the `getItem` genuinely in flight.
      readIssued.resolve(undefined);
      return readGate.promise;
    });

    __resetSessionAttentionForTests();
    const hydration = __hydrateSessionAttentionForTests();
    await readIssued.promise;
    expect(kvMock.getItem).toHaveBeenCalledTimes(1);

    await clearSessionAttentionForSignOut();

    // The read was issued for the signed-out account: resolving it after the
    // wipe must neither restore its rows nor rewrite the cleared scope.
    readGate.resolve(
      JSON.stringify([
        {
          sessionId: 's1',
          raiseId: 'R1',
          status: 'question',
          ackedAt: now,
          expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
        },
      ])
    );
    await hydration;
    await __flushSessionAttentionWritesForTests();

    expect(__peekSessionAttentionForTests('s1')).toBeUndefined();
    expect(getHydrationSnapshot()).toBe('ready');
    expect(kvStore.get(storageKey(SESSION_ATTENTION_KEY, ATTENTION_ENTRY_KEY))).toBeUndefined();
  });
});
