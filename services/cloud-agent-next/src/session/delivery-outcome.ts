import type { MessageDeliveryResult } from '../execution/types.js';

/**
 * A held delivery never reached the wrapper: the runtime refused it because the
 * previous wrapper batch was still finalizing, so the message stays queued and
 * is retried moments later.
 *
 * A hold is not a failure. Nothing about the session may be settled from one —
 * in particular no preparation attempt may be failed, because no preparation
 * was ever attempted and the retry is expected to succeed.
 */
export function isHeldDeliveryResult(result: MessageDeliveryResult): boolean {
  return !result.success && result.code === 'WRAPPER_FINALIZING';
}
