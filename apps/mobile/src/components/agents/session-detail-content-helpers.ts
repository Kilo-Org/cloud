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
 * Re-sends a failed submission as a new one, then clears the original delivery
 * failure once the re-send is accepted so it stops showing (`.specs/
 * cloud-agent-session.md`, Errors 3: a message that will never be delivered
 * shows as failed and MUST stop showing after a successful retry). The failed
 * message id is final on the server and is never re-admitted, so the re-send
 * materialises its own row with its own delivery state; the original row keeps
 * only its content — a client-materialised row that existed for its failure
 * alone stops showing — and a re-send that fails again keeps its own footer.
 *
 * A rejected re-send leaves the original footer alone: nothing was delivered,
 * so the failure is still the truth, and the manager has already surfaced it
 * through its own toast. The rejection is swallowed here so the caller's
 * `void`ed promise never rejects.
 *
 * An assistant failure's row is left alone: a failed turn stays marked, and
 * `clearFailedMessage` is about a user message's delivery entry.
 */
export async function retryFailedMessage(input: {
  message: StoredMessage;
  send: () => Promise<void>;
  clearFailedMessage: (messageId: string) => void;
}): Promise<void> {
  try {
    await input.send();
  } catch {
    return;
  }
  if (input.message.info.role !== 'user') {
    return;
  }
  input.clearFailedMessage(input.message.info.id);
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
