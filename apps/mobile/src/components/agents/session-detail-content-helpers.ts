import { type MessageDeliveryState } from '@kilocode/cloud-agent-sdk';

/**
 * Counts pending messages that are still in flight. A terminal delivery
 * failure must not count: after `status === 'failed'` the working spinner and
 * wake lock would otherwise stay on forever.
 */
export function countInFlightMessages(
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>
): number {
  let count = 0;
  for (const state of pendingMessages.values()) {
    if (state.status !== 'failed') {
      count += 1;
    }
  }
  return count;
}

/**
 * Re-sends a failed message and clears its failed row only on success. On
 * failure the row stays so the user can retry again; the manager has already
 * surfaced the failure toast, so the rejection is swallowed here.
 */
export async function retryMessageAndClear(
  send: () => Promise<void>,
  clearFailed: () => void
): Promise<void> {
  try {
    await send();
    clearFailed();
  } catch {
    // Swallow: the manager already surfaced the failure toast and the failed
    // row stays so the user can retry again.
  }
}
