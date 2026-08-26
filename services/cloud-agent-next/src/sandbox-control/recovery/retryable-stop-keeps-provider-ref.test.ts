import { describe, expect, it } from 'vitest';
import { releaseIfAuthoritativelyDead } from '../authoritative-release.js';
import { claimCreate, confirmRunning, fail, initialPhysicalRecord } from '../physical-lifecycle.js';

describe('retryable stop', () => {
  it('keeps the provider ref when stop is not terminal', () => {
    const failed = fail(
      confirmRunning(claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000), 'ref_1', 1_000),
      1_000
    );
    const next = releaseIfAuthoritativelyDead(failed, { stop: 'retryable', observe: 'active' });
    expect(next.state).toBe('failed');
    expect(next.providerRef).toBe('ref_1');
  });
});
