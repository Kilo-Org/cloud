import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { i18n } from '@/i18n';
import { getSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { getWaitingAsk } from '@/lib/glanceable/waiting-ask';
import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { getActionNotice, isActionApproving, pruneActionNotice } from './action-notice';
import { formatGlanceableClock, formatGlanceableCount } from './count-format';
import { buildNotificationActions, type LiveUpdateCard } from './live-update';
import {
  buildOngoingNotificationContent,
  type NotificationAction,
  terminalNotificationContent,
} from './ongoing-notification';

function translate(key: string): string {
  return i18n.t(key);
}

/**
 * The approve state the card draws, from either Approve: the notification's
 * own (the headless task's notice and in-flight mark) or the Home widget's
 * in-place Approve (the shared surface extras), so the card never offers
 * Approve while the widget is already answering it. A new answer outranks the
 * last failure.
 */
export function cardAction(snapshot: GlanceableAgentsSnapshot): NotificationAction {
  pruneActionNotice(snapshot);
  const widget = snapshot.needsInput > 0 ? getSurfaceExtras().actionFeedback : null;
  const approving = isActionApproving() || widget === 'approving';
  const widgetFailure = widget === 'couldNotApprove' ? translate('glanceable.approveFailed') : null;
  return { approving, failure: approving ? null : (getActionNotice() ?? widgetFailure) };
}

/** The card for `snapshot`, carrying the approve state `cardAction` reads. */
export function cardFor(snapshot: GlanceableAgentsSnapshot, terminalText?: string): LiveUpdateCard {
  const action = cardAction(snapshot);
  const content =
    terminalText === undefined
      ? buildOngoingNotificationContent(
          snapshot,
          { translate, formatCount: formatGlanceableCount, formatClock: formatGlanceableClock },
          action
        )
      : terminalNotificationContent(terminalText);
  const actions = buildNotificationActions(getWaitingAsk(), translate);
  return {
    title: content.title,
    text: content.text,
    textIsError: content.textIsError,
    subText: content.subText,
    compactText: content.compactText,
    openLabel: actions.openLabel,
    openUrl: actions.openUrl,
    // A terminal card has nothing to answer, even if a background delivery left
    // an ask recorded, and an answer in flight cannot be sent twice. Open
    // remains the route back; Approve disappears.
    approveLabel: terminalText === undefined && !action.approving ? actions.approveLabel : null,
    newAgentLabel: content.offersNewAgent ? translate('glanceable.newAgent') : null,
    newAgentUrl: LAUNCHER_NEW_AGENT_URL,
  };
}
