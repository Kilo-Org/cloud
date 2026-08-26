import { describe, expect, it } from 'vitest';
import { nextEnsureReadyStep } from '../ensure-ready.js';
import {
  beginStop,
  claimCreate,
  confirmRunning,
  confirmStopped,
  initialPhysicalRecord,
  type PhysicalState,
} from '../physical-lifecycle.js';

describe('allowCreate', () => {
  it('creates only from stopped when the caller is a user send', () => {
    expect(nextEnsureReadyStep('stopped', true)).toBe('create');
    expect(nextEnsureReadyStep('stopped', false)).toBe('return');
    expect(nextEnsureReadyStep('failed', true)).toBe('release-failed');
    expect(nextEnsureReadyStep('unknown', true)).toBe('observe-unknown');
    expect(nextEnsureReadyStep('creating', true)).toBe('return');
    expect(nextEnsureReadyStep('running', true)).toBe('return');
    expect(nextEnsureReadyStep('stopping', true)).toBe('return');
  });

  it('creates a replacement only after the stopped lifecycle clears the prior sandbox', () => {
    const running = confirmRunning(claimCreate(initialPhysicalRecord(true), 'first', 1), 'ref', 1);
    const stopping = beginStop(running, 'idle', 2);

    expect(stopping.providerRef).toBe('ref');
    expect(nextEnsureReadyStep(stopping.state, true)).toBe('return');
    expect(() => claimCreate(stopping, 'replacement', 3)).toThrow('claimCreate from stopping');

    const stopped = confirmStopped(stopping);
    expect(stopped.providerRef).toBeNull();
    expect(nextEnsureReadyStep(stopped.state, true)).toBe('create');
    expect(claimCreate(stopped, 'replacement', 3).state).toBe('creating');
  });

  it('never creates from alarm recovery, including after stopping resolves', () => {
    const states: PhysicalState[] = [
      'stopped',
      'creating',
      'running',
      'stopping',
      'failed',
      'unknown',
    ];

    for (const state of states) {
      expect(nextEnsureReadyStep(state, false)).not.toBe('create');
    }
    expect(nextEnsureReadyStep('stopping', false)).toBe('return');
    expect(nextEnsureReadyStep('stopped', false)).toBe('return');
  });
});
