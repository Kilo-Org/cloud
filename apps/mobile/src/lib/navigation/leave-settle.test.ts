// The two marks that make one Back close one screen when the press and a
// screen's own dismissal overlap. Both expire, so a press that never actually
// left the screen cannot suppress a later save.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  armLeaveSettle,
  BACK_COMMIT_MS,
  insideLeaveSettle,
  insideWindow,
  LEAVE_SETTLE_MS,
  resetLeaveSettle,
} from '@/lib/navigation/leave-settle';

beforeEach(() => {
  resetLeaveSettle();
});

describe('window', () => {
  it('holds an event that lands inside the span', () => {
    expect(insideWindow(1_000, 1_000, LEAVE_SETTLE_MS)).toBe(true);
    expect(insideWindow(1_000, 1_000 + LEAVE_SETTLE_MS - 1, LEAVE_SETTLE_MS)).toBe(true);
  });

  it('expires once the span has passed', () => {
    expect(insideWindow(1_000, 1_000 + LEAVE_SETTLE_MS, LEAVE_SETTLE_MS)).toBe(false);
  });

  it('opens nothing for a clock that stepped backwards', () => {
    expect(insideWindow(10_000, 9_000, LEAVE_SETTLE_MS)).toBe(false);
  });
});

describe('leave settle window', () => {
  it('keeps a Back that arrives before any screen dismissed itself', () => {
    expect(insideLeaveSettle(1_000)).toBe(false);
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

  it('reopens the window for a later dismissal', () => {
    armLeaveSettle(1_000);
    armLeaveSettle(5_000);
    expect(insideLeaveSettle(5_000 + LEAVE_SETTLE_MS - 1)).toBe(true);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('covers the navigator turnaround of an accepted Back with a shorter span', () => {
    // Measured 276-295 ms from a Back to the route reporting itself unfocused;
    // the span that suppresses a competing dismissal outlasts it, and ends well
    // before a reader could answer a confirmation opened by the same Back.
    expect(BACK_COMMIT_MS).toBeGreaterThan(295);
    expect(BACK_COMMIT_MS).toBeLessThan(LEAVE_SETTLE_MS);
  });
});
