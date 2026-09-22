import { describe, expect, it } from 'vitest';
import { nextEnsureReadyStep } from '../ensure-ready.js';
import {
  beginStop,
  claimCreate,
  confirmRunning,
  confirmStopped,
  initialPhysicalRecord,
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

  it('creates from a queued-head alarm only after the allocation is stopped', () => {
    // A queued head passes `allowCreate: true`, but a replacement is only
    // realized from a confirmed `stopped` allocation. Running and stopping
    // allocations are observed, not replaced, and failed/unknown allocations
    // reconcile first.
    for (const state of ['creating', 'running', 'stopping'] as const) {
      expect(nextEnsureReadyStep(state, true)).not.toBe('create');
    }
    expect(nextEnsureReadyStep('failed', true)).toBe('release-failed');
    expect(nextEnsureReadyStep('unknown', true)).toBe('observe-unknown');
    expect(nextEnsureReadyStep('stopped', true)).toBe('create');
  });
});
