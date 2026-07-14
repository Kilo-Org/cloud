import { describe, expect, it } from 'vitest';

import {
  classifyAttentionEvent,
  computeNextAttemptAt,
  extractAttentionSignal,
  extractStableRequestId,
  isActionable,
  isResolvedEvent,
  MAX_ATTEMPTS,
  type AttentionReason,
} from './attention-outbox';
import {
  applyRaiseIntent,
  applyResolveIntent,
  applyRetry,
  applyStaleInFlightRecovery,
  type OutboxRow,
  type OutboxStatus,
} from './attention-outbox-store';

describe('classifyAttentionEvent', () => {
  it.each([
    ['question.asked', 'raise', 'question'],
    ['question.replied', 'resolve', null],
    ['question.rejected', 'resolve', null],
    ['permission.asked', 'raise', 'permission'],
    ['permission.replied', 'resolve', null],
  ] as const)('maps %s to %s', (event, kind, reason) => {
    const result = classifyAttentionEvent(event, {});
    expect(result?.kind).toBe(kind);
    expect(result?.reason ?? null).toBe(reason);
  });

  describe('suggestion events', () => {
    it('raises a blocking_suggestion when blocking:true is explicit', () => {
      const result = classifyAttentionEvent('suggestion.shown', { blocking: true });
      expect(result).toEqual({ kind: 'raise', reason: 'blocking_suggestion' });
    });

    it('ignores a suggestion.shown without blocking flag', () => {
      expect(classifyAttentionEvent('suggestion.shown', {})).toBeNull();
    });

    it('ignores a suggestion.shown with blocking string "true"', () => {
      expect(classifyAttentionEvent('suggestion.shown', { blocking: 'true' })).toBeNull();
    });

    it('ignores a suggestion.shown with blocking number 1', () => {
      expect(classifyAttentionEvent('suggestion.shown', { blocking: 1 })).toBeNull();
    });

    it('ignores a suggestion.shown with blocking:false', () => {
      expect(classifyAttentionEvent('suggestion.shown', { blocking: false })).toBeNull();
    });

    it('resolves a suggestion.accepted regardless of blocking flag', () => {
      expect(classifyAttentionEvent('suggestion.accepted', { id: 's_1' })).toEqual({
        kind: 'resolve',
        reason: null,
      });
    });

    it('resolves a suggestion.dismissed regardless of blocking flag', () => {
      expect(classifyAttentionEvent('suggestion.dismissed', { id: 's_1' })).toEqual({
        kind: 'resolve',
        reason: null,
      });
    });
  });

  it('ignores session.status updates', () => {
    expect(classifyAttentionEvent('session.status', { status: 'busy' })).toBeNull();
  });

  it('ignores message.updated events', () => {
    expect(classifyAttentionEvent('message.updated', { id: 'msg_1' })).toBeNull();
  });

  it('ignores network wait and offline events', () => {
    expect(classifyAttentionEvent('session.network.asked', { id: 'nw_1' })).toBeNull();
    expect(classifyAttentionEvent('session.network.restored', { id: 'nw_1' })).toBeNull();
    expect(classifyAttentionEvent('session.offline', {})).toBeNull();
  });

  it('ignores automatic retry events', () => {
    expect(classifyAttentionEvent('session.retry', { attempt: 2 })).toBeNull();
  });

  it('ignores action_required typed events (no safe Kilo contract yet)', () => {
    // The shared reason stays available in the schema, but the raw Kilo
    // contract does not yet expose a stable request id and genuinely
    // user-actionable typed action, so the producer ignores it.
    expect(classifyAttentionEvent('action_required', { id: 'ar_1' })).toBeNull();
  });

  it('ignores unknown event names', () => {
    expect(classifyAttentionEvent('question.exploded', {})).toBeNull();
    expect(classifyAttentionEvent('', {})).toBeNull();
  });
});

describe('isActionable', () => {
  it('returns true for raise events', () => {
    expect(isActionable({ kind: 'raise', reason: 'question' })).toBe(true);
    expect(isActionable({ kind: 'raise', reason: 'permission' })).toBe(true);
    expect(isActionable({ kind: 'raise', reason: 'blocking_suggestion' })).toBe(true);
  });

  it('returns false for resolve events', () => {
    expect(isActionable({ kind: 'resolve', reason: null })).toBe(false);
  });
});

describe('isResolvedEvent', () => {
  it('returns true for resolve intents only', () => {
    expect(isResolvedEvent({ kind: 'resolve', reason: null })).toBe(true);
    expect(isResolvedEvent({ kind: 'raise', reason: 'question' })).toBe(false);
  });
});

describe('computeNextAttemptAt', () => {
  const NOW = 1_000_000;

  it('schedules the first attempt immediately', () => {
    expect(computeNextAttemptAt(0, NOW)).toBe(NOW);
  });

  it('backs off exponentially up to MAX_ATTEMPTS', () => {
    expect(computeNextAttemptAt(1, NOW)).toBe(NOW + 5_000);
    expect(computeNextAttemptAt(2, NOW)).toBe(NOW + 15_000);
    expect(computeNextAttemptAt(3, NOW)).toBe(NOW + 60_000);
    expect(computeNextAttemptAt(4, NOW)).toBe(NOW + 5 * 60_000);
    expect(computeNextAttemptAt(5, NOW)).toBe(NOW + 15 * 60_000);
    // The helper caps at attempt 6; attempt 7 is parked at terminal failed by
    // callers, but the clamped safety-net value is still the cap.
    expect(computeNextAttemptAt(7, NOW)).toBe(NOW + 60 * 60_000);
  });

  it('exposes MAX_ATTEMPTS as a stable ceiling for the caller', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe('AttentionReason re-exports', () => {
  it('exposes the supported reasons for downstream code', () => {
    const reasons: AttentionReason[] = ['question', 'permission', 'blocking_suggestion'];
    expect(reasons).toHaveLength(3);
  });
});

/**
 * Pure transition helpers extracted from `attention-outbox-store.ts`.
 * The drizzle layer in the store is the one that persists these, so we
 * exercise the rules here without touching SQLite. Drizzle-backed
 * integration coverage is expected to land alongside the DO wiring.
 */
describe('outbox store pure transitions', () => {
  const NOW = 1_700_000_000_000;

  function baseRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
    return {
      requestId: 'req_1',
      reason: 'question',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: NOW,
      lastError: null,
      raisedAt: NOW,
      resolvedAt: null,
      ...overrides,
    };
  }

  describe('applyRaiseIntent', () => {
    it('builds a fresh pending row with no retry history', () => {
      const row = applyRaiseIntent({ requestId: 'req_1', reason: 'question', now: NOW });
      expect(row).toEqual({
        requestId: 'req_1',
        reason: 'question',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: NOW,
        lastError: null,
        raisedAt: NOW,
        resolvedAt: null,
      });
    });
  });

  describe('applyResolveIntent', () => {
    it('collapses a pending row to terminal resolved and clears retry state', () => {
      const next = applyResolveIntent(baseRow({ status: 'pending' }), NOW + 1);
      expect(next.status).toBe('resolved');
      expect(next.resolvedAt).toBe(NOW + 1);
      expect(next.nextAttemptAt).toBeNull();
      expect(next.lastError).toBeNull();
      // Original raise metadata is preserved for audit.
      expect(next.raisedAt).toBe(NOW);
    });

    it('collapses an in_flight row to terminal resolved and clears retry state', () => {
      const next = applyResolveIntent(
        baseRow({ status: 'in_flight', attemptCount: 2, lastError: 'boom' }),
        NOW + 1
      );
      expect(next.status).toBe('resolved');
      expect(next.resolvedAt).toBe(NOW + 1);
      expect(next.nextAttemptAt).toBeNull();
      expect(next.lastError).toBeNull();
    });

    it('keeps a terminal status and only stamps resolvedAt when missing', () => {
      const next = applyResolveIntent(baseRow({ status: 'dispatched' }), NOW + 5);
      expect(next.status).toBe('dispatched');
      expect(next.resolvedAt).toBe(NOW + 5);
    });

    it('keeps a parked-failed terminal status and only stamps resolvedAt when missing', () => {
      const next = applyResolveIntent(
        baseRow({ status: 'failed', attemptCount: MAX_ATTEMPTS }),
        NOW + 5
      );
      expect(next.status).toBe('failed');
      expect(next.resolvedAt).toBe(NOW + 5);
    });

    it('is a no-op when called twice on a terminal row', () => {
      const once = applyResolveIntent(baseRow({ status: 'dispatched' }), NOW + 5);
      const twice = applyResolveIntent(once, NOW + 50);
      expect(twice).toBe(once);
    });

    it('is a no-op when called twice on a resolved row', () => {
      const once = applyResolveIntent(baseRow({ status: 'pending' }), NOW + 5);
      const twice = applyResolveIntent(once, NOW + 50);
      expect(twice).toBe(once);
      expect(twice.status).toBe('resolved');
      expect(twice.resolvedAt).toBe(NOW + 5);
    });
  });

  describe('applyRetry', () => {
    it('bumps attemptCount, schedules the next attempt, and keeps status pending', () => {
      const next = applyRetry(baseRow({ attemptCount: 1 }), NOW + 100, 'transient');
      expect(next.status).toBe('pending');
      expect(next.attemptCount).toBe(2);
      expect(next.nextAttemptAt).toBe(computeNextAttemptAt(2, NOW + 100));
      expect(next.lastError).toBe('transient');
    });

    it('preserves retry behavior for in_flight rows', () => {
      const next = applyRetry(
        baseRow({ status: 'in_flight', attemptCount: 2 }),
        NOW + 100,
        'transient'
      );
      expect(next.status).toBe('pending');
      expect(next.attemptCount).toBe(3);
      expect(next.nextAttemptAt).toBe(computeNextAttemptAt(3, NOW + 100));
      expect(next.lastError).toBe('transient');
    });

    it('parks at terminal failed when the cap is reached', () => {
      const next = applyRetry(
        baseRow({ attemptCount: MAX_ATTEMPTS - 1 }),
        NOW + 100,
        'still failing'
      );
      expect(next.status).toBe('failed');
      expect(next.attemptCount).toBe(MAX_ATTEMPTS);
      expect(next.nextAttemptAt).toBeNull();
      expect(next.lastError).toBe('still failing');
    });

    it.each([
      'resolved',
      'dispatched',
      'suppressed_presence',
      'missing_session',
      'failed',
    ] as OutboxStatus[])('is a no-op for terminal status %s', status => {
      const existing = baseRow({ status, attemptCount: 3 });
      const next = applyRetry(existing, NOW + 100, 'should not apply');
      expect(next).toBe(existing);
      expect(next.status).toBe(status);
      expect(next.attemptCount).toBe(3);
      expect(next.lastError).toBeNull();
      expect(next.nextAttemptAt).toBe(existing.nextAttemptAt);
    });

    it('truncates oversized lastError values to keep the row bounded', () => {
      const huge = 'x'.repeat(2000);
      const next = applyRetry(baseRow({ attemptCount: 0 }), NOW, huge);
      expect(next.lastError?.length).toBe(512);
    });
  });

  describe('applyStaleInFlightRecovery', () => {
    it('moves an in_flight row back to pending with a fresh schedule', () => {
      const next = applyStaleInFlightRecovery(
        baseRow({ status: 'in_flight', attemptCount: 0 }),
        NOW + 100
      );
      expect(next.status).toBe('pending');
      expect(next.attemptCount).toBe(1);
      expect(next.nextAttemptAt).toBe(computeNextAttemptAt(1, NOW + 100));
      expect(next.lastError).toBe('stale_in_flight_recovered');
    });

    it('parks at terminal failed when the recovery bump hits MAX_ATTEMPTS', () => {
      const next = applyStaleInFlightRecovery(
        baseRow({
          status: 'in_flight',
          attemptCount: MAX_ATTEMPTS - 1,
          lastError: 'previous error',
        }),
        NOW + 100
      );
      expect(next.status).toBe('failed');
      expect(next.attemptCount).toBe(MAX_ATTEMPTS);
      expect(next.nextAttemptAt).toBeNull();
      expect(next.lastError).toBe('stale_in_flight_recovered');
      expect(next.resolvedAt).toBeNull();
    });
  });

  describe('idempotent raise contract', () => {
    it('applyRaiseIntent always produces a fresh pending row (dedup lives in the store)', () => {
      // recordRaiseIntent short-circuits on an existing row before this
      // helper is called, so the pure helper itself is intentionally
      // unconditional. This test documents that contract so future
      // refactors do not move dedup into the helper by accident.
      const fresh = applyRaiseIntent({ requestId: 'req_1', reason: 'question', now: NOW });
      expect(fresh.status).toBe('pending');
      expect(fresh.resolvedAt).toBeNull();
      expect(fresh.attemptCount).toBe(0);
      expect(fresh.lastError).toBeNull();
    });
  });
});

describe('extractStableRequestId', () => {
  it('reads a direct id', () => {
    expect(extractStableRequestId({ id: 'r_1' })).toBe('r_1');
  });

  it('reads a direct requestId', () => {
    expect(extractStableRequestId({ requestId: 'r_2' })).toBe('r_2');
  });

  it('reads a direct requestID', () => {
    expect(extractStableRequestId({ requestID: 'r_3' })).toBe('r_3');
  });

  it('falls back to nested properties', () => {
    expect(extractStableRequestId({ properties: { id: 'nested_1' } })).toBe('nested_1');
  });

  it('prefers the top-level id over nested properties', () => {
    expect(extractStableRequestId({ id: 'top', properties: { id: 'nested' } })).toBe('top');
  });

  it('returns null for malformed or missing ids', () => {
    expect(extractStableRequestId(null)).toBeNull();
    expect(extractStableRequestId('string')).toBeNull();
    expect(extractStableRequestId([])).toBeNull();
    expect(extractStableRequestId({ id: '' })).toBeNull();
    expect(extractStableRequestId({})).toBeNull();
    expect(extractStableRequestId({ properties: {} })).toBeNull();
    expect(extractStableRequestId({ properties: { id: '' } })).toBeNull();
  });
});

describe('extractAttentionSignal', () => {
  it('raises a question', () => {
    expect(extractAttentionSignal('question.asked', { id: 'q_1' })).toEqual({
      intent: { kind: 'raise', reason: 'question' },
      requestId: 'q_1',
    });
  });

  it('raises a permission', () => {
    expect(extractAttentionSignal('permission.asked', { requestId: 'p_1' })).toEqual({
      intent: { kind: 'raise', reason: 'permission' },
      requestId: 'p_1',
    });
  });

  it('raises an explicit blocking suggestion', () => {
    expect(extractAttentionSignal('suggestion.shown', { id: 's_1', blocking: true })).toEqual({
      intent: { kind: 'raise', reason: 'blocking_suggestion' },
      requestId: 's_1',
    });
  });

  it('resolves question.replied and question.rejected', () => {
    expect(extractAttentionSignal('question.replied', { id: 'q_1' })).toEqual({
      intent: { kind: 'resolve', reason: null },
      requestId: 'q_1',
    });
    expect(extractAttentionSignal('question.rejected', { id: 'q_1' })).toEqual({
      intent: { kind: 'resolve', reason: null },
      requestId: 'q_1',
    });
  });

  it('resolves permission.replied', () => {
    expect(extractAttentionSignal('permission.replied', { id: 'p_1' })).toEqual({
      intent: { kind: 'resolve', reason: null },
      requestId: 'p_1',
    });
  });

  it('resolves suggestion.accepted and suggestion.dismissed', () => {
    expect(extractAttentionSignal('suggestion.accepted', { id: 's_1' })).toEqual({
      intent: { kind: 'resolve', reason: null },
      requestId: 's_1',
    });
    expect(extractAttentionSignal('suggestion.dismissed', { id: 's_1' })).toEqual({
      intent: { kind: 'resolve', reason: null },
      requestId: 's_1',
    });
  });

  it('ignores a nonblocking suggestion', () => {
    expect(extractAttentionSignal('suggestion.shown', { id: 's_1', blocking: false })).toBeNull();
  });

  it('ignores a missing request id', () => {
    expect(extractAttentionSignal('question.asked', {})).toBeNull();
  });

  it('ignores network and retry events', () => {
    expect(extractAttentionSignal('session.network.asked', { id: 'nw_1' })).toBeNull();
    expect(extractAttentionSignal('session.retry', { id: 'r_1' })).toBeNull();
  });

  it('ignores action_required events', () => {
    expect(extractAttentionSignal('action_required', { id: 'ar_1' })).toBeNull();
  });
});
