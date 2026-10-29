import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { type MessageFailure, selectMessageFailure } from './message-failure-state';
import { firstHumanText } from './part-types';
import { transcriptRendersMessage } from './session-transcript';

export function restoreCanceledQueuedMessages(
  messages: StoredMessage[],
  canceled: ReadonlyMap<string, StoredMessage>
): StoredMessage[] {
  const ids = new Set(messages.map(message => message.info.id));
  let result = messages;
  for (const message of canceled.values()) {
    if (!ids.has(message.info.id)) {
      if (result === messages) {
        result = [...messages];
      }
      const index = result.findIndex(
        candidate =>
          candidate.info.id > message.info.id ||
          (candidate.info.role === 'assistant' &&
            candidate.info.parentID === message.info.id &&
            candidate.info.sessionID === message.info.sessionID)
      );
      result.splice(index === -1 ? result.length : index, 0, message);
      ids.add(message.info.id);
    }
  }
  return result;
}

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
 * Re-sends a superseded turn as a new one, then records every row the retry
 * replaces as resolved once the re-send is accepted, so they stop showing
 * (`.specs/cloud-agent-session.md`, Errors 3: a message that will never be
 * delivered shows as failed and MUST stop showing after a successful retry).
 * The replaced message ids are final on the server and are never re-admitted,
 * so the re-send materialises its own row with its own delivery state; a
 * replaced row keeps only its content — a client-materialised row that existed
 * for its failure alone stops showing — and a re-send that fails again keeps
 * its own footer.
 *
 * A retry of a failed user row replaces that row alone. A retry of a failed
 * assistant response also replaces the user row whose prompt it re-sends: the
 * re-send is a new user turn with the same text, so leaving the original
 * would render the prompt twice, and the failed response row is superseded by
 * the retried turn's own.
 *
 * A rejected re-send leaves the original rows alone: nothing was delivered, so
 * the failure is still the truth, and the manager has already surfaced it
 * through its own toast. The rejection is swallowed here so the caller's
 * `void`ed promise never rejects.
 */
export async function retryFailedMessage(input: {
  replacedMessageIds: readonly string[];
  send: () => Promise<void>;
  clearFailedMessage: (messageId: string) => void;
}): Promise<void> {
  try {
    await input.send();
  } catch {
    return;
  }
  for (const messageId of input.replacedMessageIds) {
    input.clearFailedMessage(messageId);
  }
}

/**
 * The rows a Retry tap replaces, and the prompt to re-send. A user delivery
 * failure re-sends the row's own first human-authored text part and replaces
 * that row; an assistant failure re-sends the newest preceding user row's text
 * and replaces both the failed response and the user row it re-sends. Returns
 * null when there is no human text (e.g. a file-only row) or no preceding user
 * row, which suppresses Retry.
 */
export type RetryTarget = {
  prompt: string;
  /** The failed row first, then the user row whose prompt it re-sends. */
  replacedMessageIds: readonly string[];
};

export function resolveRetryTarget(
  message: StoredMessage,
  messages: readonly StoredMessage[]
): RetryTarget | null {
  if (message.info.role === 'user') {
    const text = firstHumanText(message.parts);
    return text === '' ? null : { prompt: text, replacedMessageIds: [message.info.id] };
  }
  const index = messages.findIndex(candidate => candidate.info.id === message.info.id);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.info.role === 'user') {
      const text = firstHumanText(candidate.parts);
      if (text === '') {
        return null;
      }
      return {
        prompt: text,
        replacedMessageIds: [message.info.id, candidate.info.id],
      };
    }
  }
  return null;
}

/**
 * The text a Retry tap re-sends, or null when Retry is not available for this
 * row. The transcript uses it as the availability gate; the tap itself reads
 * the full target from `resolveRetryTarget`.
 */
export function resolveRetryPrompt(
  message: StoredMessage,
  messages: readonly StoredMessage[]
): string | null {
  return resolveRetryTarget(message, messages)?.prompt ?? null;
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
  /** The same transcript rule the screen merged the rows with, so the walk
   * below cannot count a row that was dropped from the list. */
  dropUnrenderableUserRows?: boolean;
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
  dropUnrenderableUserRows,
}: LastVisibleFailureInput): MessageFailure | null {
  // Only a rendered row can own the failure statement. Contentless assistant
  // errors render their failure footer; other invisible messages are skipped.
  // Walk back to the last row `mergeSessionTranscript` actually renders: reading
  // `displayedMessages.at(-1)` let a dropped failure suppress the footer's own
  // line and leave the failure with no surface at all.
  const last = lastRenderedMessage(displayedMessages, pendingMessages, dropUnrenderableUserRows);
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
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>,
  dropUnrenderableUserRows: boolean | undefined
): StoredMessage | undefined {
  for (let i = displayedMessages.length - 1; i >= 0; i -= 1) {
    const message = displayedMessages[i];
    if (
      message !== undefined &&
      transcriptRendersMessage(message, pendingMessages, dropUnrenderableUserRows)
    ) {
      return message;
    }
  }
  return undefined;
}
