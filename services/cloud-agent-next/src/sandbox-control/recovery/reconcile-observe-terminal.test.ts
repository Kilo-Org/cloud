import { describe, expect, it } from 'vitest';
import { reconcileLostConnection } from '../lost-connection.js';
import { claimCreate, confirmRunning, initialPhysicalRecord } from '../physical-lifecycle.js';

describe('reconcile lost connection when observe is terminal', () => {
  it('fails the instance, keeps the ref, and does not arm reconnect grace', () => {
    const running = confirmRunning(
      claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000),
      'ref_1',
      1_000
    );
    const planned = reconcileLostConnection(running, 'terminal');
    expect(planned.record.state).toBe('failed');
    expect(planned.record.providerRef).toBe('ref_1');
    expect(planned.armReconnectGrace).toBe(false);
  });
});
