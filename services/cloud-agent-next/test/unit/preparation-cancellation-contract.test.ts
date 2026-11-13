import { describe, expect, it } from 'vitest';
import { isPreparationCancellation } from '../../../../packages/cloud-agent-sdk/src/preparation-attempts.js';
import { messageFailureText } from '../../src/control-plane/session/failure-messages.js';

describe('preparation cancellation contract', () => {
  it('recognizes the control-plane cancellation copy in the SDK', () => {
    expect(isPreparationCancellation(messageFailureText('preparation_cancelled'))).toBe(true);
    expect(isPreparationCancellation(messageFailureText('preparation_timeout'))).toBe(false);
  });
});
