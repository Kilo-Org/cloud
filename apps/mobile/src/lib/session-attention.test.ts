import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __peekSessionAttentionForTests,
  __resetSessionAttentionForTests,
  ackSessionAttention,
  getRevisionSnapshot,
  isAttentionAcked,
  reconcileSessionAttention,
  sessionNeedsInput,
  shouldShowNeedsInput,
  subscribe,
} from './session-attention';

beforeEach(() => {
  __resetSessionAttentionForTests();
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

  it('re-opening a session with a stale resolved ack re-pends and hides the new raise', () => {
    ackSessionAttention('s1');
    reconcileSessionAttention('s1', 'question', 'R1');
    // new raise R2 arrives and is not acked
    expect(isAttentionAcked('s1', 'R2')).toBe(false);
    // user opens the session again → ack overwrites with pending
    ackSessionAttention('s1');
    expect(isAttentionAcked('s1', 'R2')).toBe(true);
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

  it('frozen-return sequence: pending entry resolves via reconcile, then next raise is not absorbed', () => {
    // raise R1 observed, then user opens the session (ack → pending)
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

  it('reconcile with attention status and a resolved entry is a no-op (does not bump revision)', () => {
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

    // different raiseId → resolved entry blocks absorb, no change
    reconcileSessionAttention('s1', 'question', 'R2');
    expect(getRevisionSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(isAttentionAcked('s1', 'R1')).toBe(true);
    expect(isAttentionAcked('s1', 'R2')).toBe(false);

    unsubscribe();
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

    // Repeated open of the same still-pending session is a no-op.
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

  it('bumps revision on mutating reconciles (resolve, delete) and stays stable on no-ops', () => {
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

    // no-op reconciles: no entry → no change; resolved entry → no change
    reconcileSessionAttention('s2', 'busy', null);
    reconcileSessionAttention('s1', 'question', 'R1');
    reconcileSessionAttention('s1', 'question', 'R2');
    reconcileSessionAttention('s1', 'question', null);

    expect(getRevisionSnapshot()).toBe(afterMutations);
    expect(listener).toHaveBeenCalledTimes(mutations);

    // delete → mutation
    reconcileSessionAttention('s1', 'busy', null);
    expect(getRevisionSnapshot()).toBe(afterMutations + 1);
    expect(listener).toHaveBeenCalledTimes(mutations + 1);

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
