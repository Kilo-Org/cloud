// The two windows that make one Back close one screen when the press and a
// screen's own dismissal overlap. Each is bounded: a press that never actually
// left the screen cannot block a later save.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  armLeaveSettle,
  backInFlight,
  insideLeaveSettle,
  LEAVE_SETTLE_MS,
  noteAcceptedBack,
  resetLeaveSettle,
} from '@/lib/navigation/leave-settle';

beforeEach(() => {
  resetLeaveSettle();
});

describe('leave settle window', () => {
  it('keeps a Back that arrives before any screen dismissed itself', () => {
    expect(insideLeaveSettle(1_000)).toBe(false);
    expect(backInFlight(1_000)).toBe(false);
  });

  it('spends a Back that arrives inside the dismissal window', () => {
    armLeaveSettle(1_000);
    expect(insideLeaveSettle(1_000)).toBe(true);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS - 1)).toBe(true);
  });

  it('lets a Back through once the dismissal window has closed', () => {
    armLeaveSettle(1_000);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('suppresses a save that resolves while its own Back is being applied', () => {
    noteAcceptedBack(1_000);
    expect(backInFlight(1_000 + 1)).toBe(true);
    expect(backInFlight(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('stops suppressing after the window, so a later save still dismisses', () => {
    noteAcceptedBack(1_000);
    expect(backInFlight(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('keeps the two windows apart', () => {
    noteAcceptedBack(1_000);
    expect(insideLeaveSettle(1_000 + 10)).toBe(false);

    armLeaveSettle(5_000);
    expect(backInFlight(5_000 + 10)).toBe(false);
  });

  it('reopens a window for a later event', () => {
    armLeaveSettle(1_000);
    armLeaveSettle(5_000);
    expect(insideLeaveSettle(5_000 + LEAVE_SETTLE_MS - 1)).toBe(true);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('treats a clock that stepped backwards as no event inside the window', () => {
    armLeaveSettle(10_000);
    noteAcceptedBack(10_000);
    expect(insideLeaveSettle(9_000)).toBe(false);
    expect(backInFlight(9_000)).toBe(false);
  });
});
