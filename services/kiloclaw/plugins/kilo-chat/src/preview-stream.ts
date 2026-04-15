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

  /** Once the stream is terminal (`finalize` / `abort` called), all entry points no-op. */
  const isDone = () => phase === 'finalized' || phase === 'aborted';

  async function flushOnce(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (isDone()) return;
    if (inFlight) {
      await inFlight;
      // Do NOT re-enter: the caller (update-path post-flush check or timer-path
      // post-flush check) is responsible for rescheduling if pendingText remains.
      // Re-entering here would either duplicate in-flight slots or starve the
      // caller's reschedule opportunity.
      return;
    }
    const text = pendingText;
    if (text === undefined) return;
    pendingText = undefined;
    if (text === lastSentText) return;

    if (messageId === undefined) {
      // First send: POST.
      const p = opts.client
        .createMessage({ conversationId: opts.conversationId, content: [{ type: 'text', text }] })
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
        content: [{ type: 'text', text }],
        version: nextVersion,
      })
      .then(res => {
        version = res.version;
        if (res.dropped) {
          // Server rejected our version (409). Do NOT record `lastSentText`:
          // the remote preview still shows older text, and a subsequent flush
          // or finalize must re-send to catch the user up.
          warn('editMessage dropped (stale version) during stream');
        } else {
          lastSentText = text;
        }
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
      if (isDone()) return;
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
      if (isDone()) {
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
          content: [{ type: 'text', text: finalText }],
        });
        messageId = res.messageId;
        version = res.version;
        lastSentText = finalText;
        phase = 'finalized';
        return { messageId };
      }
      if (finalText !== lastSentText) {
        let nextVersion = version + 1;
        try {
          let res = await opts.client.editMessage({
            conversationId: opts.conversationId,
            messageId,
            content: [{ type: 'text', text: finalText }],
            version: nextVersion,
          });
          // On final edit, a 409 drop would leave the user-visible message
          // stuck on older text. Retry once with a freshly-bumped version.
          if (res.dropped) {
            warn('editMessage dropped (stale version) during finalize; retrying');
            version = res.version;
            nextVersion = version + 1;
            res = await opts.client.editMessage({
              conversationId: opts.conversationId,
              messageId,
              content: [{ type: 'text', text: finalText }],
              version: nextVersion,
            });
          }
          version = res.version;
          if (!res.dropped) {
            lastSentText = finalText;
          } else {
            warn('editMessage dropped twice during finalize; remote preview may be stale');
          }
        } catch (err) {
          warn('editMessage failed during finalize', err);
          throw err;
        }
      }
      phase = 'finalized';
      return { messageId };
    },
    async abort(): Promise<void> {
      if (isDone()) return;
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
