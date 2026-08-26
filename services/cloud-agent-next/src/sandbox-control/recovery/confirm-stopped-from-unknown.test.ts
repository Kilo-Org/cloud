import { describe, expect, it } from 'vitest';
import {
  claimCreate,
  confirmRunning,
  confirmStopped,
  initialPhysicalRecord,
  observe,
} from '../physical-lifecycle.js';

describe('confirmStopped from unknown', () => {
  it('wipes the provider ref after an explicit terminal confirm', () => {
    const unknown = observe(
      confirmRunning(claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000), 'ref_1', 1_000),
      'unknown'
    );
    expect(unknown.state).toBe('unknown');
    expect(unknown.providerRef).toBe('ref_1');

    expect(confirmStopped(unknown)).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });
});
