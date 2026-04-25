// Outbound delivery wiring for an inbound Kilo Chat message turn. Translates
// the SDK's block-dispatcher events (partial replies + committed blocks) into
// a single evolving preview message via the preview-stream helper.

import type { KiloChatClient } from '../client.js';
import { createPreviewStream } from '../preview-stream.js';

/**
 * Default coalescing window between outbound PATCH edits during streaming.
 * Not user-configurable: the plugin always streams, and 500ms is the product
 * default agreed with the external chat service.
 */
const STREAM_THROTTLE_MS = 500;

export type DeliverPayload = { text?: string };

export type DeliverWiring = {
  deliver: (payload: DeliverPayload) => Promise<void>;
  replyOptions: {
    onPartialReply: (payload: { text?: string }) => void | Promise<void>;
  };
  /** Cleanup hook — call after dispatch completes or throws. Pass the error if any. */
  finalize: (err?: unknown) => Promise<void>;
};

export function buildDeliverWiring(params: {
  client: KiloChatClient;
  conversationId: string;
  inReplyToMessageId?: string;
  warn: (msg: string, err?: unknown) => void;
}): DeliverWiring {
  const stream = createPreviewStream({
    client: params.client,
    conversationId: params.conversationId,
    throttleMs: STREAM_THROTTLE_MS,
    inReplyToMessageId: params.inReplyToMessageId,
    onWarn: params.warn,
  });

  // Aggregates the agent's reply into a single preview message:
  //
  //   committedMessages: closed-out messages from earlier iterations of this turn
  //                      (e.g., an assistant message preceding a tool call).
  //   currentText:       cumulative text of the in-progress assistant message.
  //
  // The SDK emits onPartialReply with the FULL cumulative text of the current
  // assistant message (not a delta) and onBlockReply with a chunk — a slice of
  // that cumulative text at chunker boundaries (paragraph break, maxChars,
  // idle gap, text_end flush). When a chunker boundary fires mid-message, the
  // next partial still carries the cumulative text that already contains the
  // delivered chunk as a prefix, so naïvely concatenating the two produces a
  // duplicated prefix. The logic below treats the partial as the authoritative
  // cumulative view of the current message and only folds a deliver chunk in
  // when it isn't already represented.
  const committedMessages: string[] = [];
  let currentText = '';
  let delivered = false;

  const BLOCK_JOINER = '\n\n';
  const accumulated = (): string => {
    const parts = currentText ? [...committedMessages, currentText] : committedMessages;
    return parts.join(BLOCK_JOINER);
  };

  return {
    replyOptions: {
      onPartialReply: async payload => {
        if (!payload.text) return;
        // A new partial that doesn't extend the previous one signals a new
        // assistant message (e.g., after a tool call). Close out the previous.
        if (currentText && !payload.text.startsWith(currentText)) {
          committedMessages.push(currentText);
        }
        currentText = payload.text;
        stream.update(accumulated());
      },
    },
    deliver: async payload => {
      if (!payload.text) return;
      if (!currentText) {
        // No partial for this message yet — the chunk is all we have.
        currentText = payload.text;
      } else if (currentText.includes(payload.text)) {
        // Chunk is already part of the cumulative partial — nothing to add.
      } else if (payload.text.includes(currentText)) {
        // Partial lagged behind the final chunk (e.g., text_end flushed without
        // a trailing partial) — the chunk is the authoritative text.
        currentText = payload.text;
      } else {
        // Unrelated chunk (tool-result block without partials, etc.) — append.
        currentText = `${currentText}${BLOCK_JOINER}${payload.text}`;
      }
      delivered = true;
      stream.update(accumulated());
    },
    finalize: async err => {
      if (err !== undefined || !delivered) {
        await stream.abort(err);
        return;
      }
      await stream.finalize(accumulated());
    },
  };
}
