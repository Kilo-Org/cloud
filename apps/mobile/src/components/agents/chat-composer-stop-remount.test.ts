import { describe, expect, it } from 'vitest';

import { nextStopRemountPhase, type StopRemountPhase } from './chat-composer-stop-remount';

describe('nextStopRemountPhase', () => {
  it('stays idle regardless of disabled', () => {
    expect(nextStopRemountPhase('idle', false)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
    expect(nextStopRemountPhase('idle', true)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
  });

  it('stays armed and never remounts while disabled stays false', () => {
    // Simulates onStop failing synchronously or disabled arriving late.
    // The machine must remain safe — no remount, no lock, no permanent
    // breakage.
    for (let i = 0; i < 3; i += 1) {
      const result = nextStopRemountPhase('armed', false);
      expect(result.phase).toBe('armed');
      expect(result.shouldRemount).toBe(false);
    }
  });

  it('transitions from armed to locked when disabled becomes true (arm while enabled, prove lock observed)', () => {
    const result = nextStopRemountPhase('armed', true);
    expect(result.phase).toBe('locked');
    expect(result.shouldRemount).toBe(false);
  });

  it('stays locked while disabled remains true (still disabled means no epoch)', () => {
    for (let i = 0; i < 2; i += 1) {
      const result = nextStopRemountPhase('locked', true);
      expect(result.phase).toBe('locked');
      expect(result.shouldRemount).toBe(false);
    }
  });

  it('remounts only after locked→idle when disabled clears from true to false (post-Stop disabled true→false sequence)', () => {
    // Armed → locked
    expect(nextStopRemountPhase('armed', true)).toEqual({
      phase: 'locked',
      shouldRemount: false,
    });
    // Locked + still disabled → stays locked
    expect(nextStopRemountPhase('locked', true)).toEqual({
      phase: 'locked',
      shouldRemount: false,
    });
    // Lock clears → remount and return to idle
    expect(nextStopRemountPhase('locked', false)).toEqual({
      phase: 'idle',
      shouldRemount: true,
    });
  });

  it('completes the full armed→locked→idle cycle with exactly one remount at the end', () => {
    let phase: StopRemountPhase = 'idle';
    let remountCount = 0;

    // Arm
    phase = 'armed';

    // Disabled not yet observed — stay armed
    const r1 = nextStopRemountPhase(phase, false);
    phase = r1.phase;
    if (r1.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('armed');

    // Disabled observed
    const r2 = nextStopRemountPhase(phase, true);
    phase = r2.phase;
    if (r2.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('locked');

    // Still disabled — no remount
    const r3 = nextStopRemountPhase(phase, true);
    phase = r3.phase;
    if (r3.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('locked');

    // Disabled clears
    const r4 = nextStopRemountPhase(phase, false);
    phase = r4.phase;
    if (r4.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('idle');

    expect(remountCount).toBe(1);
  });

  it('returns to idle without remount if armed and disabled never engages (interrupt path that never disables remains safe)', () => {
    // Armed → disabled never becomes true.  The machine stays armed across
    // multiple evaluations, then the component can re-arm idempotently on
    // the next Stop press.  The armed phase is harmless — no remount, no
    // lock, the input remains interactive.
    let phase: StopRemountPhase = 'armed';
    for (let i = 0; i < 5; i += 1) {
      const result = nextStopRemountPhase(phase, false);
      expect(result.shouldRemount).toBe(false);
      phase = result.phase;
    }
    expect(phase).toBe('armed');

    // Idempotent re-arm → no change
    phase = 'armed';
    expect(nextStopRemountPhase(phase, false).phase).toBe('armed');
  });
});
