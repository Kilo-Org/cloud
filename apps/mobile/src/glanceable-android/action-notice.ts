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

/** The notice waiting to reach the next notification text, or null. */
export function getActionNotice(): string | null {
  return actionNotice;
}

/** Drop the notice once nothing needs input or the recorded ask has changed. */
export function pruneActionNotice(snapshot: GlanceableAgentsSnapshot): void {
  if (
    actionNotice !== null &&
    (snapshot.needsInput === 0 || askKey(getWaitingAsk()) !== noticeAskKey)
  ) {
    actionNotice = null;
    noticeAskKey = null;
  }
}
