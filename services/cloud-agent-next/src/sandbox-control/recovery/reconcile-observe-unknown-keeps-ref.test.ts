import { describe, expect, it } from 'vitest';
import { reconcileLostConnection } from '../lost-connection.js';
import { claimCreate, confirmRunning, initialPhysicalRecord } from '../physical-lifecycle.js';

describe('reconcile lost connection when observe is unknown', () => {
  it('keeps the provider ref and does not create', () => {
    const running = confirmRunning(
      claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000),
      'ref_1',
      1_000
    );
    const planned = reconcileLostConnection(running, 'unknown');
    expect(planned.record.state).toBe('unknown');
    expect(planned.record.providerRef).toBe('ref_1');
    expect(planned.armReconnectGrace).toBe(false);
  });
});
