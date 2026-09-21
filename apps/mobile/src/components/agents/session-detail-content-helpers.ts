import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { type MessageFailure, selectMessageFailure } from './message-failure-state';
import { firstHumanText } from './part-types';
import { transcriptRendersMessage } from './session-transcript';

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

type LastVisibleFailureInput = {
  /** The rendered list, in order. Its last entry the transcript renders owns
   * the row above the footer. */
  displayedMessages: readonly StoredMessage[];
  /** The full list, for the retry prompt's preceding-user search. */
  messages: readonly StoredMessage[];
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  /** Canceled rows kept locally, keyed by message id. */
  canceledQueuedMessages: ReadonlyMap<string, StoredMessage>;
};

/**
 * The failure footer the transcript's last message row renders, or `null` when
 * that row renders none. The fixed footer's status indicator uses this to tell
 * a failure the row already states (which it must not repeat) from a
 * session-level error the row does not carry (which only the footer can show).
 *
 * Mirrors MessageBubble's own gate: a footer needs a failure and a wired
 * action. Copy to composer is always wired on a delivery failure, so only an
 * assistant failure can be left without one (no preceding user row).
 */
export function lastVisibleMessageFailure({
  displayedMessages,
  messages,
  pendingMessages,
  canceledQueuedMessages,
}: LastVisibleFailureInput): MessageFailure | null {
  // The transcript drops a message whose parts render nothing (unless its
  // delivery failed and its typed footer is the row's surface), so such a
  // message owns no row and cannot state a failure. Walk back to the last row
  // `mergeSessionTranscript` actually renders: reading `displayedMessages.at(-1)`
  // let a dropped failure suppress the footer's own line and leave the failure
  // with no surface at all.
  const last = lastRenderedMessage(displayedMessages, pendingMessages);
  if (last === undefined) {
    return null;
  }
  const deliveryState =
    last.info.role === 'user' && !canceledQueuedMessages.has(last.info.id)
      ? pendingMessages.get(last.info.id)
      : undefined;
  const failure = selectMessageFailure({ deliveryState, info: last.info });
  if (failure === null || failure.kind === 'delivery') {
    return failure;
  }
  return resolveRetryPrompt(last, messages) !== null ? failure : null;
}

/**
 * The last message `mergeSessionTranscript` renders, or `undefined` when it
 * renders none. A dropped message is invisible, so the row above the footer is
 * the one before it.
 */
function lastRenderedMessage(
  displayedMessages: readonly StoredMessage[],
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>
): StoredMessage | undefined {
  for (let i = displayedMessages.length - 1; i >= 0; i -= 1) {
    const message = displayedMessages[i];
    if (message !== undefined && transcriptRendersMessage(message, pendingMessages)) {
      return message;
    }
  }
  return undefined;
}
