import { useEffect, useRef, useState } from 'react';

import { planAutoApproveReply } from './session-auto-approve';

/** Sends the per-ask "once" reply and reports whether it can be retried. */
export type SessionAutoApproveRespond = (
  requestId: string
) => Promise<'ok' | 'retryable' | 'terminal'>;

type SessionAutoApproveInput = {
  /** True only when the toggle is on for this session. */
  enabled: boolean;
  /** True only when this session can receive permission asks. */
  available: boolean;
  /** The head pending permission request id, or null when none waits. */
  requestId: string | null;
  /** Replies "once" to a permission request; resolves with the outcome. */
  respond: SessionAutoApproveRespond;
};

type SessionAutoApproveResult = {
  /**
   * The request id whose permission card must not render, or null when the
   * card should show (toggle off, session unavailable, or a failed reply).
   */
  suppressedRequestId: string | null;
};

/**
 * Drives the per-session auto-reply for one pending permission ask.
 *
 * Only permission request ids reach this hook; questions never do, so a
 * clarification question is never auto-answered. The hook replies with
 * "once" only, so no persisted or global permission rule is written.
 *
 * The suppression is derived during render from two refs — ids already
 * answered and ids whose reply failed — so the permission card is gated out on
 * the same frame the ask arrives (never a one-frame flash). A failed reply
 * flips a state counter, re-rendering with the card visible for its Retry CTA.
 */
export function useSessionAutoApprove({
  enabled,
  available,
  requestId,
  respond,
}: SessionAutoApproveInput): SessionAutoApproveResult {
  const handledRequestIdsRef = useRef<Set<string>>(new Set());
  const failedRequestIdsRef = useRef<Set<string>>(new Set());
  // Bumped only when a reply fails, to re-render with the card un-suppressed.
  const [, setFailedVersion] = useState(0);
  // Latest responder without re-running the effect for a new function identity
  // on every render of the caller.
  const respondRef = useRef(respond);
  respondRef.current = respond;

  const plan = planAutoApproveReply({
    enabled,
    available,
    requestId,
    handledRequestIds: handledRequestIdsRef.current,
    failedRequestIds: failedRequestIdsRef.current,
  });
  const replyRequestId = plan.replyRequestId;

  useEffect(() => {
    // Guard against a StrictMode double-invoke (and any re-run) re-sending an
    // ask that this hook already answered.
    if (replyRequestId === null || handledRequestIdsRef.current.has(replyRequestId)) {
      return;
    }
    handledRequestIdsRef.current.add(replyRequestId);
    const markFailed = () => {
      handledRequestIdsRef.current.delete(replyRequestId);
      failedRequestIdsRef.current.add(replyRequestId);
      setFailedVersion(version => version + 1);
    };
    void (async () => {
      try {
        const outcome = await respondRef.current(replyRequestId);
        if (outcome === 'retryable') {
          markFailed();
        }
      } catch {
        markFailed();
      }
    })();
  }, [replyRequestId]);

  return { suppressedRequestId: plan.suppressedRequestId };
}
