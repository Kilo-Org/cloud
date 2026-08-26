import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../deadlines.js';
import { reconcileLostConnection } from '../lost-connection.js';
import { claimCreate, confirmRunning, initialPhysicalRecord } from '../physical-lifecycle.js';

describe('reconcile lost connection when observe is active', () => {
  it('stays running and arms wrapper-readiness as reconnect grace', () => {
    const running = confirmRunning(
      claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000),
      'ref_1',
      1_000
    );
    const planned = reconcileLostConnection(running, 'active');
    expect(planned.record.state).toBe('running');
    expect(planned.record.providerRef).toBe('ref_1');
    expect(planned.armReconnectGrace).toBe(true);
    expect(DEADLINE_MS.wrapperReadiness).toBe(90_000);
  });
});
