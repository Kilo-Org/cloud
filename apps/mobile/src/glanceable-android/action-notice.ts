import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { getWaitingAsk, type WaitingAsk } from '@/lib/glanceable/waiting-ask';

/**
 * The retryable-failure notice the headless approve task leaves for the next
 * republish, and the ask it belongs to. It never outlives its ask — a changed
 * ask or a zero needs-input count clears it — so a failure message cannot
 * describe a new session.
 *
 * Kept beside the sink rather than inside it: the sink owns the native post and
 * the widget, and this state is what keeps it under the line limit. Nothing
 * here reaches the native layer, so the headless-entry boundary is unchanged.
 */
let actionNotice: string | null = null;
let noticeAskKey: string | null = null;
/** An Approve tap is being answered: the card says "Approving…" and drops Approve. */
let approving = false;

/** The recorded ask identity the notice describes; '' means "no ask". */
function askKey(ask: WaitingAsk | null): string {
  return ask === null ? '' : `${ask.kiloSessionId}|${ask.status}`;
}

/**
 * Set (or clear) the notice for the next republish. Records the ask it belongs
 * to, so the drop rule below can tell a stale notice from a current one.
 */
export function setGlanceableActionNotice(notice: string | null): void {
  actionNotice = notice;
  noticeAskKey = notice === null ? null : askKey(getWaitingAsk());
}

/**
 * Mark (or clear) the in-flight answer; it ends with the ask like the notice does.
 * A new answer supersedes the last failure: the notice outranks "Approving…" on
 * the card, so a retry would otherwise keep showing the old failure line.
 */
export function setGlanceableActionApproving(value: boolean): void {
  approving = value;
  if (value) {
    setGlanceableActionNotice(null);
  }
}

export function isActionApproving(): boolean {
  return approving;
}

/** The notice waiting to reach the next notification text, or null. */
export function getActionNotice(): string | null {
  return actionNotice;
}

/** Drop the notice (and the in-flight mark) once nothing needs input; the notice also when the ask changed. */
export function pruneActionNotice(snapshot: GlanceableAgentsSnapshot): void {
  if (snapshot.needsInput === 0) {
    approving = false;
  }
  if (
    actionNotice !== null &&
    (snapshot.needsInput === 0 || askKey(getWaitingAsk()) !== noticeAskKey)
  ) {
    actionNotice = null;
    noticeAskKey = null;
  }
}
