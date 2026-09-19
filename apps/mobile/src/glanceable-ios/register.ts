import { Platform } from 'react-native';

import { i18n } from '@/i18n';
import { approveFrontAgent } from '@/lib/glanceable/approve-front-agent';
import { getGlanceableDelivery, registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import {
  getLiveActivityEnabled,
  subscribeLiveActivityEnabled,
} from '@/lib/glanceable/live-activity-switch';

import { adoptPushStartedActivity } from './adopt-activity';
import { refreshActiveAgentsLiveActivityCopy } from './active-agents-live-activity';
import { refreshActiveAgentsWidgetCopy } from './active-agents-widget';
import { registerGlanceableApproveAction } from './approve-action';
import { iosSink } from './ios-sink';
import { registerWidgetActionHandling } from './widget-actions';
import { ensureWidgetLogo } from './widget-logo';

if (Platform.OS === 'ios') {
  // Registers the iOS Live Activity and widget sink at import time. The root
  // layout imports this file on both platforms; Android owns
  // glanceable-android/register. Never create a React dependency here: the
  // publisher is plain state, and widgets get translated copy through the sink,
  // not through a mounted component tree.
  registerGlanceableSink(iosSink);

  // Widget App Intent buttons: the live subscription answers a press while this
  // process is up, and the launch sweep picks up a press that patched the
  // timeline before JS subscribed.
  registerWidgetActionHandling();

  // The Live Activity's Approve control mirrors to the Apple Watch, so a wrist
  // press arrives as a widget interaction in this process. It runs the same
  // front-approval service the phone's permission card uses; the caller is a
  // thunk because the service reads its scope and attaches lazily. This is a
  // second interaction listener beside `registerWidgetActionHandling`: each
  // handler filters on its own surface (this one on the `approve` target, the
  // widget sweep on the Home Screen widget's press marker), so a press is
  // answered by exactly one of them.
  registerGlanceableApproveAction(async () => {
    await approveFrontAgent();
  });

  // Copy the Kilo mark into the shared app group so the widget extension can read
  // it. Fire and forget: it lands long before the first snapshot arrives, and a
  // failure only costs the logo.
  void ensureWidgetLogo();

  // Claim a card raised by a push-to-start before anything else runs. iOS grants
  // this process background run time for exactly that, and the server cannot
  // update or end the card until its update token arrives.
  void adoptPushStartedActivity();

  // The layouts bake their copy in at import, when i18n still holds English: the
  // stored language is applied a few ticks later. Re-bake on every language
  // change so both the Live Activity and the widget gallery placeholder follow
  // the user's language.
  i18n.on('languageChanged', () => {
    refreshActiveAgentsLiveActivityCopy();
    refreshActiveAgentsWidgetCopy();
  });

  // Turning the in-app switch off must clear the activity already on the Lock
  // Screen, not just stop the next start. `startOrUpdate` holds the guard for
  // everything after this.
  let liveActivityAllowed = getLiveActivityEnabled();
  subscribeLiveActivityEnabled(() => {
    const next = getLiveActivityEnabled();
    if (liveActivityAllowed && !next) {
      iosSink.endImmediate();
      // `endImmediate` retires only the activity tokens. The push-to-start
      // subscription outlives them, so a remote start would still reach a
      // switched-off surface. `canRegisterActivityTokenKind` keeps it retired
      // until the switch returns.
      getGlanceableDelivery().cleanupTokens('scope');
    }
    liveActivityAllowed = next;
  });
}
