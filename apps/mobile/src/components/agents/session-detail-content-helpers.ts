import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { firstHumanText } from './part-types';

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
 * Re-sends a failed submission as a new one. The failed row keeps its typed
 * footer and its Retry action: it is the record of a submission that did fail,
 * and the re-send materialises its own row with its own delivery state. Clearing
 * the original footer on an accepted re-send left the transcript with fewer
 * failure footers than failed submissions (the re-send can fail too), so the
 * failed row's state is left alone. The manager has already surfaced any failure
 * through its own toast, so the rejection is swallowed here.
 */
export async function retryFailedMessage(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch {
    // Swallow: the manager already surfaced the failure toast and the failed
    // row stays so the user can retry again.
  }
}

/**
 * Resolves the retry prompt for a failed row. A user delivery failure re-sends
 * the row's own first human-authored text part; an assistant failure re-sends
 * the newest preceding user row's. Returns null when there is no human text
 * (e.g. a file-only row) or no preceding user row, which suppresses Retry.
 */
export function resolveRetryPrompt(
  message: StoredMessage,
  messages: readonly StoredMessage[]
): string | null {
  if (message.info.role === 'user') {
    const text = firstHumanText(message.parts);
    return text === '' ? null : text;
  }
  const index = messages.findIndex(candidate => candidate.info.id === message.info.id);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.info.role === 'user') {
      const text = firstHumanText(candidate.parts);
      return text === '' ? null : text;
    }
  }
  return null;
}
