import { describe, expect, it } from 'vitest';
import {
  acceptCoveredMessages,
  advanceAcceptedOwnership,
  applyCleanupOutcome,
  emptyAcceptedOwnership,
  extendAcceptedCoverage,
  hasUnresolvedCleanup,
  pruneAcceptedOwnership,
  selectCleanupRetries,
} from './accepted-ownership.js';
import type { ControlPlaneTimers } from '../../shared/control-plane-timers.js';

const timers = {
  acceptedCoverageMs: 180_000,
  acceptedProbeMs: 60_000,
  acceptedProbeTimeoutMs: 10_000,
} as ControlPlaneTimers['session'];

const ALLOCATION = 'allocation-a';

describe('accepted coverage ownership', () => {
  it('initializes a three-minute obligation from acceptance and never extends it on replay', () => {
    const start = 1_000_000;
    const state = acceptCoveredMessages(
      emptyAcceptedOwnership(),
      ['m1'],
      ALLOCATION,
      start,
      timers
    );
    expect(state.entries.m1).toMatchObject({
      acceptedAt: start,
      coveredUntil: start + 180_000,
      nextProbeAt: start + 60_000,
    });
    const replay = acceptCoveredMessages(state, ['m1'], ALLOCATION, start + 30_000, timers);
    expect(replay.entries.m1).toEqual(state.entries.m1);
  });

  it('expires only after a failed probe cadence and accumulates a cleanup id', () => {
    let state = acceptCoveredMessages(emptyAcceptedOwnership(), ['m1'], ALLOCATION, 0, timers);
    const firstProbe = advanceAcceptedOwnership(state, 60_000, timers);
    state = firstProbe.state;
    expect(firstProbe.probes).toMatchObject([
      { allocationId: ALLOCATION, messageIds: ['m1'], startedAt: 60_000 },
    ]);
    expect(state.entries.m1?.coveredUntil).toBe(180_000);

    // The probe failed: no extension. At the deadline the entry expires and
    // cleanup becomes due in the same scheduling step.
    const expiry = advanceAcceptedOwnership(state, 180_000, timers);
    state = expiry.state;
    expect(expiry.expired).toEqual([{ allocationId: ALLOCATION, messageIds: ['m1'] }]);
    expect(state.entries).toEqual({});
    expect(state.cleanup).toEqual([
      { allocationId: ALLOCATION, messageIds: ['m1'], retryAt: 180_000 },
    ]);
  });

  it('extends only explicitly covered ids from the scheduled probe time', () => {
    const state = acceptCoveredMessages(
      emptyAcceptedOwnership(),
      ['m1', 'm2'],
      ALLOCATION,
      0,
      timers
    );
    const scheduled = advanceAcceptedOwnership(state, 60_000, timers);
    const extended = extendAcceptedCoverage(scheduled.state, scheduled.probes[0]!, ['m1'], timers);
    expect(extended.entries.m1?.coveredUntil).toBe(240_000);
    expect(extended.entries.m2?.coveredUntil).toBe(180_000);
    // A missing probe result cannot renew anything.
    const missing = extendAcceptedCoverage(scheduled.state, scheduled.probes[0]!, [], timers);
    expect(missing).toBe(scheduled.state);
  });

  it('drops terminal coverage but keeps a recorded cleanup obligation', () => {
    let state = acceptCoveredMessages(
      emptyAcceptedOwnership(),
      ['m1', 'm2'],
      ALLOCATION,
      0,
      timers
    );
    state = advanceAcceptedOwnership(state, 180_000, timers).state;
    expect(hasUnresolvedCleanup(state, ALLOCATION)).toBe(true);
    expect(pruneAcceptedOwnership(state, ['m2']).cleanup).toEqual(state.cleanup);
  });

  it('a stale abandon reply removes only its own ids, never a newer expiry', () => {
    let state = acceptCoveredMessages(emptyAcceptedOwnership(), ['m1'], ALLOCATION, 0, timers);
    state = advanceAcceptedOwnership(state, 180_000, timers).state;
    state = acceptCoveredMessages(state, ['m2'], ALLOCATION, 200_000, timers);
    state = advanceAcceptedOwnership(state, 380_000, timers).state;
    expect(state.cleanup[0]?.messageIds).toEqual(['m1', 'm2']);

    const stale = selectCleanupRetries(state, 380_000, timers);
    expect(stale.batches[0]?.messageIds).toEqual(['m1', 'm2']);
    const partialReply = { ...stale.batches[0]!, messageIds: ['m1'] };
    state = applyCleanupOutcome(stale.state, partialReply, 'abandoned', 381_000, timers);
    expect(state.cleanup).toEqual([
      { allocationId: ALLOCATION, messageIds: ['m2'], retryAt: 440_000 },
    ]);
    expect(hasUnresolvedCleanup(state, ALLOCATION)).toBe(true);
  });

  it('a deferred abandon stays uncleaned and retries on the bounded cadence', () => {
    let state = acceptCoveredMessages(emptyAcceptedOwnership(), ['m1'], ALLOCATION, 0, timers);
    state = advanceAcceptedOwnership(state, 180_000, timers).state;
    const due = selectCleanupRetries(state, 180_000, timers);
    expect(due.batches).toHaveLength(1);
    state = applyCleanupOutcome(due.state, due.batches[0]!, 'deferred', 181_000, timers);
    expect(state.cleanup[0]).toMatchObject({ messageIds: ['m1'], retryAt: 241_000 });
  });
});
