import { describe, expect, it } from 'vitest';
import {
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  observe,
} from '../physical-lifecycle.js';

describe('observe unknown + active', () => {
  it('becomes running when a provider ref exists', () => {
    const running = confirmRunning(
      claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000),
      'ref_1',
      1_000
    );
    const unknown = observe(running, 'unknown');
    expect(unknown.state).toBe('unknown');
    expect(unknown.providerRef).toBe('ref_1');

    const next = observe(unknown, 'active');
    expect(next.state).toBe('running');
    expect(next.providerRef).toBe('ref_1');
  });
});
