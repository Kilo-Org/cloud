/**
 * The answer a person typed into a needs-input notification and has not sent
 * yet, held for the session's question card to offer when the chat screen
 * opens.
 *
 * The text lives only in this module's memory: it is an answer the person
 * typed, the notification that carried it is the only other copy, and the slot
 * dies with the process. A restart therefore costs a retype and never leaves
 * the answer somewhere it was not meant to be — not the durable draft store,
 * not SecureStore, not a URL, and not a log.
 *
 * The slot is observable: a tap on the result while the session's chat screen is
 * already the top route changes no route param, so the screen learns about the
 * answer through a subscription instead of a remount.
 */

// One raise per session reaches the shade in practice; the cap covers the few
// a person can act on, and the oldest answer is dropped first so a backlog
// cannot grow the slot without bound.
const MAX_SESSIONS = 8;

const drafts = new Map<string, string>();

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Hold one typed answer until the session's question card offers it. */
export function rememberNeedsInputReplyDraft(kiloSessionId: string, text: string): void {
  if (text.trim().length === 0) {
    return;
  }
  // Re-insert so the newest answer is also the last entry, and the cap drops
  // the session that has waited longest.
  drafts.delete(kiloSessionId);
  drafts.set(kiloSessionId, text);
  for (const oldestSession of drafts.keys()) {
    if (drafts.size <= MAX_SESSIONS) {
      break;
    }
    drafts.delete(oldestSession);
  }
  notifyListeners();
}

/** The session's held answer without clearing it. */
export function peekNeedsInputReplyDraft(kiloSessionId: string): string | null {
  return drafts.get(kiloSessionId) ?? null;
}

/** The session's held answer, if it has one; the slot empties as it is read. */
export function takeNeedsInputReplyDraft(kiloSessionId: string): string | null {
  const text = drafts.get(kiloSessionId);
  if (text === undefined) {
    return null;
  }
  drafts.delete(kiloSessionId);
  notifyListeners();
  return text;
}

/** Drop the session's held answer without offering it. */
export function clearNeedsInputReplyDraft(kiloSessionId: string): void {
  drafts.delete(kiloSessionId);
  notifyListeners();
}

/** Subscribe to slot changes. Returns an unsubscribe function. */
export function subscribeNeedsInputReplyDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: empty the slot so one case cannot see another's answer. */
export function _resetNeedsInputReplyDraftForTests(): void {
  drafts.clear();
}
