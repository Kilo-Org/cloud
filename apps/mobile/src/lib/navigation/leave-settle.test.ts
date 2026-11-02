// The two marks that make one Back close one screen when a press and a
// screen's own dismissal overlap. Each ends on the event that settles it, so
// neither depends on a device's speed nor outlives the leave it describes.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  armLeaveSettle,
  backAcceptedBy,
  clearAcceptedBack,
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

  it('opens nothing for a clock that stepped backwards', () => {
    armLeaveSettle(10_000);
    expect(insideLeaveSettle(9_000)).toBe(false);
  });
});

describe('accepted Back', () => {
  it('holds until the navigator acts on it, however long that takes', () => {
    noteAcceptedBack('route-a', 1_000);
    expect(backAcceptedBy('route-a')).toBe(true);
    // No clock: a slow device or a raised animator scale only lengthens the
    // interval, and the route still has not left.
    expect(backAcceptedBy('route-a')).toBe(true);
  });

  it('belongs only to the route that accepted it', () => {
    noteAcceptedBack('route-a', 1_000);
    expect(backAcceptedBy('route-b')).toBe(false);
  });

  it('is forgotten when the navigator applies the leave', () => {
    noteAcceptedBack('route-a', 1_000);
    clearAcceptedBack('route-a');
    expect(backAcceptedBy('route-a')).toBe(false);
  });

  it('is forgotten when the reader cancels the leave', () => {
    noteAcceptedBack('route-a', 1_000);
    clearAcceptedBack();
    expect(backAcceptedBy('route-a')).toBe(false);
  });

  it('cannot be cleared by another route', () => {
    noteAcceptedBack('route-a', 1_000);
    clearAcceptedBack('route-b');
    expect(backAcceptedBy('route-a')).toBe(true);
  });

  it('does not keep a screen from dismissing itself once the mark is gone', () => {
    noteAcceptedBack('route-a', 1_000);
    clearAcceptedBack('route-a');
    armLeaveSettle(2_000);
    expect(insideLeaveSettle(2_000)).toBe(true);
  });

  it('starts empty', () => {
    expect(backAcceptedBy('route-a')).toBe(false);
  });
});
