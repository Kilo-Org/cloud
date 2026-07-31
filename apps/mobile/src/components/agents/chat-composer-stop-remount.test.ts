import { describe, expect, it } from 'vitest';

import { nextStopRemountPhase, type StopRemountPhase } from './chat-composer-stop-remount';

describe('nextStopRemountPhase', () => {
  it('stays idle regardless of disabled and stopCompleted', () => {
    expect(nextStopRemountPhase('idle', false, false)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
    expect(nextStopRemountPhase('idle', true, false)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
    expect(nextStopRemountPhase('idle', false, true)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
    expect(nextStopRemountPhase('idle', true, true)).toEqual({
      phase: 'idle',
      shouldRemount: false,
    });
  });

  it('stays armed while onStop has not completed, regardless of disabled', () => {
    // Disabled arrival before stop completes — harmless, still armed.
    for (let i = 0; i < 3; i += 1) {
      const result = nextStopRemountPhase('armed', false, false);
      expect(result.phase).toBe('armed');
      expect(result.shouldRemount).toBe(false);
    }
    for (let i = 0; i < 3; i += 1) {
      const result = nextStopRemountPhase('armed', true, false);
      expect(result.phase).toBe('armed');
      expect(result.shouldRemount).toBe(false);
    }
  });

  it('transitions armed→settled when stop completes but row is still disabled', () => {
    const result = nextStopRemountPhase('armed', true, true);
    expect(result.phase).toBe('settled');
    expect(result.shouldRemount).toBe(false);
  });

  it('transitions armed→idle with remount when stop completes and row is already enabled (missed-react-transition fix)', () => {
    // React never committed disabled=true — the SDK's false→true→false cycle
    // was batched into a single render with disabled=false.  After onStop
    // settles, remount immediately.
    const result = nextStopRemountPhase('armed', false, true);
    expect(result.phase).toBe('idle');
    expect(result.shouldRemount).toBe(true);
  });

  it('stays settled while disabled remains true (row still locked after stop)', () => {
    for (let i = 0; i < 2; i += 1) {
      const result = nextStopRemountPhase('settled', true, false);
      expect(result.phase).toBe('settled');
      expect(result.shouldRemount).toBe(false);
    }
    for (let i = 0; i < 2; i += 1) {
      const result = nextStopRemountPhase('settled', true, true);
      expect(result.phase).toBe('settled');
      expect(result.shouldRemount).toBe(false);
    }
  });

  it('remounts after settled→idle when disabled clears (classic stop-complete-then-unlock path)', () => {
    // Stop completed, row was disabled, now it clears.
    expect(nextStopRemountPhase('settled', false, false)).toEqual({
      phase: 'idle',
      shouldRemount: true,
    });
    expect(nextStopRemountPhase('settled', false, true)).toEqual({
      phase: 'idle',
      shouldRemount: true,
    });
  });

  it('completes the full armed→settled→idle cycle with disabled observed (classic path)', () => {
    let phase: StopRemountPhase = 'idle';
    let remountCount = 0;

    // Arm
    phase = 'armed';

    // onStop still in flight — stay armed
    const r1 = nextStopRemountPhase(phase, true, false);
    phase = r1.phase;
    if (r1.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('armed');

    // onStop completed, disabled still true → settled
    const r2 = nextStopRemountPhase(phase, true, true);
    phase = r2.phase;
    if (r2.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('settled');

    // Still disabled — stay settled
    const r3 = nextStopRemountPhase(phase, true, true);
    phase = r3.phase;
    if (r3.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('settled');

    // Disabled clears → remount
    const r4 = nextStopRemountPhase(phase, false, true);
    phase = r4.phase;
    if (r4.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('idle');

    expect(remountCount).toBe(1);
  });

  it('completes the armed→idle cycle when disabled was NEVER true (missed-react-transition path)', () => {
    // The real E2E failure: SDK writes false→true→false in one React batch.
    // The component never commits disabled=true.  onStop completes,
    // disabled is already false → remount immediately.
    let phase: StopRemountPhase = 'idle';
    let remountCount = 0;

    // Arm
    phase = 'armed';

    // onStop in flight — stay armed
    const r1 = nextStopRemountPhase(phase, false, false);
    phase = r1.phase;
    if (r1.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('armed');

    // Another frame with disabled still false, onStop still in flight
    const r2 = nextStopRemountPhase(phase, false, false);
    phase = r2.phase;
    if (r2.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('armed');

    // onStop completed, disabled still false → remount immediately
    const r3 = nextStopRemountPhase(phase, false, true);
    phase = r3.phase;
    if (r3.shouldRemount) {
      remountCount += 1;
    }
    expect(phase).toBe('idle');

    expect(remountCount).toBe(1);
  });

  it('handles rapid double-Stop: first completion is ignored, last one drives remount', () => {
    // Simulate what the component does with stopGenerationRef:
    // Stop 1: gen=1, setStopCompleted(false)
    // Stop 2: gen=2, setStopCompleted(false)
    // Stop 1 promise resolves → generation check fails, no-op
    // Stop 2 promise resolves → stopCompleted=true

    let phase: StopRemountPhase = 'idle';
    phase = 'armed';

    // Stop 2 overrides — arm again idempotently
    phase = 'armed';

    // onStop 1 completes but generation is stale → stopCompleted stays false.
    // Machine stays armed.
    const r1 = nextStopRemountPhase(phase, false, false);
    expect(r1.phase).toBe('armed');
    expect(r1.shouldRemount).toBe(false);

    // onStop 2 completes → stopCompleted=true, disabled false → remount
    const r2 = nextStopRemountPhase('armed', false, true);
    expect(r2.phase).toBe('idle');
    expect(r2.shouldRemount).toBe(true);
  });

  it('handles rapid double-Stop where first stop completed and second is still in flight', () => {
    // Stop 1: gen=1
    // Stop 2: gen=2 (re-arms, resets stopCompleted)
    // Stop 1 resolves, gen=1 ≠ 2 → ignored (stopCompleted stays false)
    // Machine stays armed waiting for gen 2 to complete
    const result = nextStopRemountPhase('armed', false, false);
    expect(result.phase).toBe('armed');
    expect(result.shouldRemount).toBe(false);
  });

  it('stays armed indefinitely when stopCompleted remains false (pure state-machine edge; component always signals completion)', () => {
    // The component wraps onStop in try/finally so stopCompleted is always
    // signalled, but the pure function handles the case correctly: armed
    // persists without remount, row stays interactive, and re-arm is
    // idempotent.
    let phase: StopRemountPhase = 'armed';
    for (let i = 0; i < 5; i += 1) {
      const result = nextStopRemountPhase(phase, false, false);
      expect(result.shouldRemount).toBe(false);
      phase = result.phase;
    }
    expect(phase).toBe('armed');

    // Idempotent re-arm
    phase = 'armed';
    expect(nextStopRemountPhase(phase, false, false).phase).toBe('armed');
  });
});
