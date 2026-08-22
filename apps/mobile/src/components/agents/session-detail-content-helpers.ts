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

/**
 * Runs the Connect repository action: opens the GitHub integration setup and
 * clears the terminal guidance so Continue becomes available again.
 */
export function runConnectRepository(
  openGitHubIntegration: () => void,
  clearGuidance: () => void
): void {
  openGitHubIntegration();
  clearGuidance();
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
