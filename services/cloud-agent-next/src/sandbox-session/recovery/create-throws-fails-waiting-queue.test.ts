import { describe, expect, it } from 'vitest';
import { controlDispatchDisposition } from '../control-dispatch.js';

describe('create() throws', () => {
  it('waits for a replacement instead of failing a recoverable queue', () => {
    // Prior contract: failed physical produced an `environment_failed` fail.
    // Now a non-retryable create throw / provider failure is recoverable until
    // the head deadline, so the wait-classification must not terminalize.
    expect(
      controlDispatchDisposition({
        physical: 'failed',
        connection: 'disconnected',
      })
    ).toEqual({ action: 'wait' });
  });
});
