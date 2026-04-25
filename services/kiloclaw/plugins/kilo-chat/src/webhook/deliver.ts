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

  // The SDK's block pipeline splits each agent reply into N payloads (paragraph
  // boundaries, maxChars, tool-result breaks, idle gaps). To present this as a
  // single chat message we accumulate committed block text plus the current
  // block's streaming partial, and keep editing the same preview message.
  const committedBlocks: string[] = [];
  let partialBlockText = '';
  let delivered = false;

  const BLOCK_JOINER = '\n\n';
  const accumulated = (): string => {
    const parts = partialBlockText ? [...committedBlocks, partialBlockText] : committedBlocks;
    return parts.join(BLOCK_JOINER);
  };

  return {
    replyOptions: {
      onPartialReply: async payload => {
        if (!payload.text) return;
        partialBlockText = payload.text;
        stream.update(accumulated());
      },
    },
    deliver: async payload => {
      if (!payload.text) return;
      committedBlocks.push(payload.text);
      partialBlockText = '';
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
