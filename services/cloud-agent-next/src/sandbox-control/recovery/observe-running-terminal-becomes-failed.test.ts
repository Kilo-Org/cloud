import { describe, expect, it } from 'vitest';
import {
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  observe,
} from '../physical-lifecycle.js';

describe('observe running + terminal', () => {
  it('marks the instance failed and keeps the provider ref', () => {
    const running = confirmRunning(
      claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000),
      'ref_1',
      1_000
    );
    const next = observe(running, 'terminal');
    expect(next.state).toBe('failed');
    expect(next.providerRef).toBe('ref_1');
  });
});
