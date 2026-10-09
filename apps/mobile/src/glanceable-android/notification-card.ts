import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { i18n } from '@/i18n';
import { getWaitingAsk } from '@/lib/glanceable/waiting-ask';
import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { getActionNotice, isActionApproving, pruneActionNotice } from './action-notice';
import { formatGlanceableClock, formatGlanceableCount } from './count-format';
import { buildNotificationActions, type LiveUpdateCard } from './live-update';
import {
  buildOngoingNotificationContent,
  terminalNotificationContent,
} from './ongoing-notification';

function translate(key: string): string {
  return i18n.t(key);
}

/** The card for `snapshot`, carrying the approve state the headless task left for it. */
export function cardFor(snapshot: GlanceableAgentsSnapshot, terminalText?: string): LiveUpdateCard {
  pruneActionNotice(snapshot);
  const approving = isActionApproving();
  const content =
    terminalText === undefined
      ? buildOngoingNotificationContent(
          snapshot,
          { translate, formatCount: formatGlanceableCount, formatClock: formatGlanceableClock },
          { approving, failure: getActionNotice() }
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
    approveLabel: terminalText === undefined && !approving ? actions.approveLabel : null,
    newAgentLabel: content.offersNewAgent ? translate('glanceable.newAgent') : null,
    newAgentUrl: LAUNCHER_NEW_AGENT_URL,
  };
}
