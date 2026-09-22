import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { controlDispatchDisposition } from '../control-dispatch.js';

describe('wrapper never ready', () => {
  it('waits for a replacement when wrapper-readiness expires', () => {
    // Prior contract: wrapper-readiness expiry failed the waiting queue. A
    // replacement may still be created, so the head now waits under its own
    // preparation deadline instead.
    expect(DEADLINE_MS.wrapperReadiness).toBe(90_000);
    expect(
      controlDispatchDisposition({
        physical: 'failed',
        connection: 'disconnected',
      })
    ).toEqual({ action: 'wait' });
  });
});
