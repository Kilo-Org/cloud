import type { KiloChatClient } from './client.js';

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
  onWarn?: (message: string, err?: unknown) => void;
};

/**
 * Per-conversation throttled POST/PATCH/DELETE controller.
 *
 * Semantics:
 *   - First `update` POSTs and records the server-issued `messageId` (version=1).
 *   - Subsequent `update` calls within `throttleMs` coalesce; one PATCH fires per window,
 *     always with the latest text, with version incremented each outbound PATCH.
 *   - Identical consecutive text is deduped (no HTTP).
 *   - `finalize` awaits any in-flight request, then performs exactly one final POST
 *     (if never updated) or PATCH (with final text, version+=1).
 *   - `abort` best-effort DELETEs any created message; swallows errors.
 *
 * Not reentrant across many finalize/abort calls; each instance lives for exactly
 * one inbound dispatch turn.
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
  let version = 0; // becomes 1 on first POST; increments per outbound PATCH
  let inFlight: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flushOnce(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (phase === 'aborted' || phase === 'finalized') return;
    if (inFlight) {
      await inFlight;
      return; // caller will reschedule if pendingText remains
    }
    const text = pendingText;
    if (text === undefined) return;
    pendingText = undefined;
    if (text === lastSentText) return;

    if (messageId === undefined) {
      // First send: POST.
      const p = opts.client
        .createMessage({ conversationId: opts.conversationId, text })
        .then(res => {
          messageId = res.messageId;
          version = 1;
          lastSentText = text;
          phase = 'editing';
        })
        .catch(err => {
          warn('createMessage failed during stream', err);
        })
        .finally(() => {
          if (inFlight === p) inFlight = undefined;
        });
      inFlight = p;
      await p;
      return;
    }

    // Subsequent send: PATCH.
    const nextVersion = version + 1;
    const p = opts.client
      .editMessage({
        conversationId: opts.conversationId,
        messageId,
        text,
        version: nextVersion,
      })
      .then(res => {
        version = res.version;
        lastSentText = text;
      })
      .catch(err => {
        warn('editMessage failed during stream', err);
      })
      .finally(() => {
        if (inFlight === p) inFlight = undefined;
      });
    inFlight = p;
    await p;
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
      if (phase === 'finalized' || phase === 'aborted') return;
      pendingText = text;
      if (phase === 'idle' && !inFlight) {
        // Fire the first POST without waiting for the throttle window —
        // preview latency matters most on the first token.
        void flushOnce().then(() => {
          if (pendingText !== undefined && phase === 'editing') scheduleFlush();
        });
        return;
      }
      scheduleFlush();
    },
    async finalize(finalText: string): Promise<{ messageId: string }> {
      if (phase === 'finalized' || phase === 'aborted') {
        if (!messageId) throw new Error('kilo-chat preview: finalize on aborted stream');
        return { messageId };
      }
      // Flush any in-flight + pending edits, then drive final text.
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
          text: finalText,
        });
        messageId = res.messageId;
        version = res.version;
        lastSentText = finalText;
        phase = 'finalized';
        return { messageId };
      }
      if (finalText !== lastSentText) {
        const nextVersion = version + 1;
        try {
          const res = await opts.client.editMessage({
            conversationId: opts.conversationId,
            messageId,
            text: finalText,
            version: nextVersion,
          });
          version = res.version;
          lastSentText = finalText;
        } catch (err) {
          warn('editMessage failed during finalize', err);
          throw err;
        }
      }
      phase = 'finalized';
      return { messageId };
    },
    async abort(): Promise<void> {
      if (phase === 'aborted') return;
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
      const prevPhase = phase;
      phase = 'aborted';
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
