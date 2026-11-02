// The window a Back keeps belonging to a screen that dismissed itself. It is
// what makes one Back close one screen when the press reaches JavaScript after
// the dismissing route was already removed.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  armLeaveSettle,
  insideLeaveSettle,
  LEAVE_SETTLE_MS,
  resetLeaveSettle,
} from '@/lib/navigation/leave-settle';

beforeEach(() => {
  resetLeaveSettle();
});

describe('leave settle window', () => {
  it('keeps a Back that arrives before the window opened', () => {
    expect(insideLeaveSettle(1_000)).toBe(false);
  });

  it('spends a Back that arrives inside the window', () => {
    armLeaveSettle(1_000);
    expect(insideLeaveSettle(1_000)).toBe(true);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS - 1)).toBe(true);
  });

  it('lets a Back through once the window has closed', () => {
    armLeaveSettle(1_000);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('reopens the window for a later dismissal', () => {
    armLeaveSettle(1_000);
    armLeaveSettle(5_000);
    expect(insideLeaveSettle(5_000 + LEAVE_SETTLE_MS - 1)).toBe(true);
    expect(insideLeaveSettle(1_000 + LEAVE_SETTLE_MS)).toBe(false);
  });

  it('treats a clock that stepped backwards as no Back inside the window', () => {
    armLeaveSettle(10_000);
    expect(insideLeaveSettle(9_000)).toBe(false);
  });
});