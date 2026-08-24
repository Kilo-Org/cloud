import { describe, expect, it } from 'vitest';

import type { MessageDeliveryResult } from '../execution/types.js';
import { isHeldDeliveryResult } from './delivery-outcome.js';

describe('isHeldDeliveryResult', () => {
  it('holds a delivery the runtime refused while the batch was finalizing', () => {
    const result: MessageDeliveryResult = {
      success: false,
      code: 'WRAPPER_FINALIZING',
      error: 'Wrapper batch is finalizing',
    };

    expect(isHeldDeliveryResult(result)).toBe(true);
  });

  it('does not hold other delivery failures', () => {
    for (const code of [
      'INTERNAL',
      'SANDBOX_CAPABILITY_UNAVAILABLE',
      'PAYMENT_REQUIRED',
    ] as const) {
      const result = { success: false, code, error: 'nope' } as MessageDeliveryResult;
      expect(isHeldDeliveryResult(result)).toBe(false);
    }
  });

  it('does not hold an accepted delivery', () => {
    const result: MessageDeliveryResult = {
      success: true,
      outcome: 'accepted',
      messageId: 'msg_1',
      wrapperRunId: 'run_1',
    };

    expect(isHeldDeliveryResult(result)).toBe(false);
  });
});
