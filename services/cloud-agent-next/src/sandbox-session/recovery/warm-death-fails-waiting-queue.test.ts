import { describe, expect, it } from 'vitest';
import {
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  observe,
} from '../../sandbox-control/physical-lifecycle.js';
import { controlDispatchDisposition } from '../control-dispatch.js';

describe('warm death', () => {
  it('waits for a replacement when observe reports terminal', () => {
    // Prior contract: a terminal observation failed the waiting queue. A
    // stopped/failed allocation can still be replaced, so the head now waits
    // under its preparation deadline (chunk 2 realizes the create).
    const physical = observe(
      confirmRunning(claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000), 'ref_1', 1_000),
      'terminal'
    );
    expect(physical.state).toBe('failed');
    expect(
      controlDispatchDisposition({
        physical: physical.state,
        connection: 'disconnected',
      })
    ).toEqual({ action: 'wait' });
  });
});
