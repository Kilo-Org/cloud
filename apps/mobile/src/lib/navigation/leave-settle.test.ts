// The two marks that make one Back close one screen when a press and a
// screen's own dismissal overlap. Each ends on the event that settles it, so
// neither depends on a device's speed nor outlives the leave it describes. The
// dismissal's window carries its animation and then a short grace, because the
// reader's press on the screen that went may arrive just after it went.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  armLeaveSettle,
  backAcceptedBy,
  clearAcceptedBack,
  endLeaveSettle,
  insideLeaveSettle,
  LEAVE_SETTLE_BACKSTOP_MS,
  LEAVE_SETTLE_GRACE_MS,
  noteAcceptedBack,
  resetLeaveSettle,
  settleLeaveWindow,
  spendsLeaveBackPress,
} from '@/lib/navigation/leave-settle';

beforeEach(() => {
  resetLeaveSettle();
});

describe('leave settle window', () => {
  it('keeps a Back that arrives before any screen dismissed itself', () => {
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(false);
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

  it('holds while the revealed scene has not finished appearing', () => {
    armLeaveSettle();
    // A slow device or a raised animation scale only lengthens the interval,
    // and the scene has not reported its transition end yet.
    expect(insideLeaveSettle()).toBe(true);
  });

  describe('with the backstop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops the window when the transition end never arrives', () => {
      armLeaveSettle();
      vi.advanceTimersByTime(LEAVE_SETTLE_BACKSTOP_MS - 1);
      expect(insideLeaveSettle()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(insideLeaveSettle()).toBe(false);
      // No animation ended, so no grace covers a press after it.
      expect(spendsLeaveBackPress()).toBe(false);
    });

    it('keeps the leave’s own end instead of the backstop when the event arrives first', () => {
      armLeaveSettle();
      endLeaveSettle();
      vi.advanceTimersByTime(LEAVE_SETTLE_BACKSTOP_MS * 2);
      expect(insideLeaveSettle()).toBe(false);
    });
  });
});

describe('leave grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spends a Back in the moment after the leave’s animation ended', () => {
    armLeaveSettle();
    settleLeaveWindow();
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(true);
  });

  it('spends the last millisecond of the grace and lets the next one through', () => {
    armLeaveSettle();
    settleLeaveWindow();
    vi.advanceTimersByTime(LEAVE_SETTLE_GRACE_MS - 1);
    expect(spendsLeaveBackPress()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(spendsLeaveBackPress()).toBe(false);
  });

  it('measures the second leave’s grace from its own end', () => {
    armLeaveSettle();
    settleLeaveWindow();
    vi.advanceTimersByTime(LEAVE_SETTLE_GRACE_MS - 100);

    // The reader acted again inside the earlier grace, so this leave measures
    // its own grace from its own end.
    armLeaveSettle();
    settleLeaveWindow();
    vi.advanceTimersByTime(LEAVE_SETTLE_GRACE_MS - 1);
    expect(spendsLeaveBackPress()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(spendsLeaveBackPress()).toBe(false);
  });

  it('closes the grace at once when the shell spends its press', () => {
    armLeaveSettle();
    settleLeaveWindow();
    endLeaveSettle();
    expect(spendsLeaveBackPress()).toBe(false);
  });

  it('does not open a grace for a scene that appears with no leave open', () => {
    // Every scene reports its own appearance transition, on every push and tab
    // switch, so most of those ends belong to no leave at all.
    settleLeaveWindow();
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(false);
  });
});

describe('reveal attribution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the window when another scene reports its transition end', () => {
    armLeaveSettle('scene-reveal');
    // A tab switch or a push reports its own end while this leave is pending.
    settleLeaveWindow('scene-other');
    expect(insideLeaveSettle()).toBe(true);
    expect(spendsLeaveBackPress()).toBe(true);
  });

  it('settles when the scene the dismissal revealed reports its end', () => {
    armLeaveSettle('scene-reveal');
    settleLeaveWindow('scene-reveal');
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(true);
  });

  it('settles on any scene when the dismissal named no scene', () => {
    armLeaveSettle();
    settleLeaveWindow('scene-other');
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(true);
  });

  it('settles a named leave when the transition end carries no key', () => {
    armLeaveSettle('scene-reveal');
    settleLeaveWindow();
    expect(insideLeaveSettle()).toBe(false);
    expect(spendsLeaveBackPress()).toBe(true);
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
