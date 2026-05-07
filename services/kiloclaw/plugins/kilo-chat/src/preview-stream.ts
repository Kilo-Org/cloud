import type { ContentBlock, KiloChatClient } from './client.js';

/**
 * Backend caps each text block at 8000 chars and each message at 20 content
 * blocks (see packages/kilo-chat/src/schemas.ts). Long streaming replies
 * accumulate more text than a single block can hold, so we split the text
 * into multiple text blocks before each POST/PATCH. Both this splitter and
 * the backend schema measure JS string length in UTF-16 code units, so we
 * can fill blocks to the exact cap. Messages that would exceed the 20-block
 * budget get a trailing "…truncated" marker on the last block so the
 * request stays valid and the user can tell the remote preview is partial.
 */
const TEXT_BLOCK_MAX = 8000;
const MAX_BLOCKS = 20;
const TRUNCATION_MARKER = '\n\n[…truncated]';

function buildTextContent(text: string): ContentBlock[] {
  if (text.length <= TEXT_BLOCK_MAX) return [{ type: 'text', text }];
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < text.length && blocks.length < MAX_BLOCKS; i += TEXT_BLOCK_MAX) {
    blocks.push({ type: 'text', text: text.slice(i, i + TEXT_BLOCK_MAX) });
  }
  if (blocks.length === MAX_BLOCKS && blocks.length * TEXT_BLOCK_MAX < text.length) {
    const last = blocks[MAX_BLOCKS - 1];
    const keep = TEXT_BLOCK_MAX - TRUNCATION_MARKER.length;
    blocks[MAX_BLOCKS - 1] = { type: 'text', text: last.text.slice(0, keep) + TRUNCATION_MARKER };
  }
  return blocks;
}

export type PreviewStream = {
  update(partialText: string): void;
  finalize(finalText: string): Promise<{ messageId: string }>;
  abort(reason?: unknown): Promise<void>;
};

type Phase = 'idle' | 'editing' | 'finalized' | 'aborted';

export type CreatePreviewStreamOptions = {
  client: KiloChatClient;
  conversationId: string;
  throttleMs: number;
  inReplyToMessageId?: string;
  onWarn?: (message: string, err?: unknown) => void;
};

/**
 * Per-conversation throttled POST/PATCH/DELETE controller.
 *
 * Semantics:
 *   - First `update` POSTs and records the server-issued `messageId`.
 *   - Subsequent `update` calls within `throttleMs` coalesce; one PATCH fires per window,
 *     always with the latest text and a monotonic client timestamp.
 *   - Identical consecutive text is deduped (no HTTP).
 *   - `finalize` awaits any in-flight request, then performs exactly one final POST
 *     (if never updated) or PATCH (with final text).
 *   - `abort` best-effort DELETEs any created message; swallows errors.
 */
export function createPreviewStream(opts: CreatePreviewStreamOptions): PreviewStream {
  const warn =
    opts.onWarn ??
    ((msg: string, err?: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[kilo-chat preview] ${msg}`, err);
    });

  let phase: Phase = 'idle';
  let messageId: string | undefined;
  let lastSentText: string | undefined;
  let pendingText: string | undefined;
  let inFlight: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Once the stream is terminal (`finalize` / `abort` called), all entry points no-op. */
  const isDone = () => phase === 'finalized' || phase === 'aborted';

  function flushOnce(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (isDone()) return Promise.resolve();
    if (inFlight) {
      return inFlight.then(() => {});
    }
    const text = pendingText;
    if (text === undefined) return Promise.resolve();
    pendingText = undefined;
    if (text === lastSentText) return Promise.resolve();

    // Assign inFlight synchronously BEFORE any async work so a second
    // synchronous `update()` call sees the guard immediately.
    const p = (async () => {
      if (messageId === undefined) {
        // First send: POST.
        try {
          const res = await opts.client.createMessage({
            conversationId: opts.conversationId,
            content: buildTextContent(text),
            inReplyToMessageId: opts.inReplyToMessageId,
          });
          messageId = res.messageId;
          lastSentText = text;
          phase = 'editing';
        } catch (err) {
          warn('createMessage failed during stream', err);
        }
        return;
      }

      // Subsequent send: PATCH with monotonic client timestamp.
      try {
        const res = await opts.client.editMessage({
          conversationId: opts.conversationId,
          messageId,
          content: buildTextContent(text),
          timestamp: Date.now(),
        });
        if (res.stale) {
          // Server had a newer timestamp — don't update lastSentText so the
          // next flush or finalize re-sends.
          warn('editMessage stale during stream');
        } else {
          lastSentText = text;
        }
      } catch (err) {
        warn('editMessage failed during stream', err);
      }
    })();
    inFlight = p;
    void p.finally(() => {
      if (inFlight === p) inFlight = undefined;
    });
    return p;
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      void (async () => {
        await flushOnce();
        if (pendingText !== undefined && phase === 'editing') scheduleFlush();
      })();
    }, opts.throttleMs);
  }

  return {
    update(text: string): void {
      if (isDone()) return;
      pendingText = text;
      if (phase === 'idle' && !inFlight) {
        void flushOnce().then(() => {
          if (pendingText !== undefined && phase === 'editing') scheduleFlush();
        });
        return;
      }
      scheduleFlush();
    },
    async finalize(finalText: string): Promise<{ messageId: string }> {
      if (isDone()) {
        if (!messageId) throw new Error('kilo-chat preview: finalize on aborted stream');
        return { messageId };
      }
      // Latch terminal phase synchronously so any concurrent update() call
      // observes isDone() and does not schedule further flushes during the
      // awaits below.
      phase = 'finalized';
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* best-effort */
        }
      }
      if (messageId === undefined) {
        const res = await opts.client.createMessage({
          conversationId: opts.conversationId,
          content: buildTextContent(finalText),
          inReplyToMessageId: opts.inReplyToMessageId,
        });
        messageId = res.messageId;
        lastSentText = finalText;
        return { messageId };
      }
      if (finalText !== lastSentText) {
        try {
          const res = await opts.client.editMessage({
            conversationId: opts.conversationId,
            messageId,
            content: buildTextContent(finalText),
            timestamp: Date.now(),
          });
          if (res.stale) {
            warn('final editMessage was stale — remote preview may be outdated');
          } else {
            lastSentText = finalText;
          }
        } catch (err) {
          warn('editMessage failed during finalize', err);
          throw err;
        }
      }
      return { messageId };
    },
    async abort(): Promise<void> {
      if (isDone()) return;
      // Latch terminal phase synchronously (see finalize for rationale).
      const prevPhase = phase;
      phase = 'aborted';
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* best-effort */
        }
      }
      if (messageId !== undefined) {
        try {
          await opts.client.deleteMessage({
            conversationId: opts.conversationId,
            messageId,
          });
        } catch (err) {
          warn(`deleteMessage failed during abort (prev phase: ${prevPhase})`, err);
        }
      }
    },
  };
}
