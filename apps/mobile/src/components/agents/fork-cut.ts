import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

/** Where "Fork from here" cuts the source transcript, and what the new composer starts with. */
export type ForkCut = {
  /** Inclusive cut: the clone keeps every message up to and including this one. */
  cloneUpToMessageId: string;
  /** A forked user message's text, for the new composer; null for an assistant message. */
  forkPrefillText: string | null;
};

/**
 * Compute the fork cut for one transcript message, or null when the message
 * offers no "Fork from here".
 *
 * - Assistant message: cut at the message itself.
 * - User message: cut at the message right before it, and put the message's
 *   text in the new composer so the user can edit and resend it. The first
 *   user message has nothing before it, so it offers no fork.
 * - A queued or failed message (it has a delivery state) never reached the
 *   saved transcript, and the assistant reply still streaming is not final:
 *   neither offers a fork, and neither can be the message before a user cut.
 *
 * `messages` is the session's transcript in ascending message-ID order.
 */
export function resolveForkCut(input: {
  messages: readonly StoredMessage[];
  messageId: string;
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  isSessionStreaming: boolean;
}): ForkCut | null {
  const { messages, messageId, pendingMessages, isSessionStreaming } = input;
  const index = messages.findIndex(message => message.info.id === messageId);
  const message = messages[index];
  if (message === undefined || pendingMessages.has(messageId)) {
    return null;
  }

  if (message.info.role === 'assistant') {
    const isStreamingReply =
      isSessionStreaming &&
      !messages.slice(index + 1).some(later => later.info.role === 'assistant');
    return isStreamingReply ? null : { cloneUpToMessageId: messageId, forkPrefillText: null };
  }

  const previous = previousDeliveredMessage(messages, index, pendingMessages);
  if (previous === undefined) {
    return null;
  }
  const text = message.parts
    .flatMap(part => (part.type === 'text' && part.synthetic !== true ? [part.text] : []))
    .join('\n\n')
    .trim();
  return { cloneUpToMessageId: previous.info.id, forkPrefillText: text.length > 0 ? text : null };
}

/**
 * The nearest message before `index` that reached the saved transcript. A
 * backward scan, not `findLast`: keep to what every Hermes build ships.
 */
function previousDeliveredMessage(
  messages: readonly StoredMessage[],
  index: number,
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>
): StoredMessage | undefined {
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const candidate = messages[earlier];
    if (candidate !== undefined && !pendingMessages.has(candidate.info.id)) {
      return candidate;
    }
  }
  return undefined;
}
