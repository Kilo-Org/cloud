// The two marks that make one Back close one screen when a press and a
// screen's own dismissal overlap. Each ends on the event that settles it, so
// neither depends on a device's speed nor outlives the leave it describes.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  armLeaveSettle,
  backAcceptedBy,
  clearAcceptedBack,
  endLeaveSettle,
  insideLeaveSettle,
  noteAcceptedBack,
  resetLeaveSettle,
} from '@/lib/navigation/leave-settle';

beforeEach(() => {
  resetLeaveSettle();
});

describe('leave settle window', () => {
  it('keeps a Back that arrives before any screen dismissed itself', () => {
    expect(insideLeaveSettle()).toBe(false);
  });

  it('spends a Back that arrives after a screen dismissed itself', () => {
    armLeaveSettle();
    expect(insideLeaveSettle()).toBe(true);
  });

  it('lets a Back through once the leave’s transition ended', () => {
    armLeaveSettle();
    endLeaveSettle();
    expect(insideLeaveSettle()).toBe(false);
  });

  it('reopens the window for a later dismissal', () => {
    armLeaveSettle();
    endLeaveSettle();
    armLeaveSettle();
    expect(insideLeaveSettle()).toBe(true);
  });

  it('holds no matter how far the clock moves', () => {
    armLeaveSettle();
    // No clock: a slow device or a raised animation scale only lengthens the
    // interval, and the revealed scene still has not finished appearing.
    expect(insideLeaveSettle()).toBe(true);
  });
});

describe('accepted Back', () => {
  it('holds until the navigator acts on it, however long that takes', () => {
    noteAcceptedBack('route-a');
    expect(backAcceptedBy('route-a')).toBe(true);
    expect(backAcceptedBy('route-a')).toBe(true);
  });

  it('belongs only to the route that accepted it', () => {
    noteAcceptedBack('route-a');
    expect(backAcceptedBy('route-b')).toBe(false);
  });

  it('is forgotten when the navigator applies the leave', () => {
    noteAcceptedBack('route-a');
    clearAcceptedBack('route-a');
    expect(backAcceptedBy('route-a')).toBe(false);
  });

  it('is forgotten when the reader cancels the leave', () => {
    noteAcceptedBack('route-a');
    clearAcceptedBack();
    expect(backAcceptedBy('route-a')).toBe(false);
  });

  it('cannot be cleared by another route', () => {
    noteAcceptedBack('route-a');
    clearAcceptedBack('route-b');
    expect(backAcceptedBy('route-a')).toBe(true);
  });

  it('does not keep a screen from dismissing itself once the mark is gone', () => {
    noteAcceptedBack('route-a');
    clearAcceptedBack('route-a');
    armLeaveSettle();
    expect(insideLeaveSettle()).toBe(true);
  });

  it('starts empty', () => {
    expect(backAcceptedBy('route-a')).toBe(false);
  });
});
