import { Platform } from 'react-native';

// iOS-only by capability: the press subscription below reaches the Live
// Activity through `expo-widgets` (WidgetKit/ActivityKit), which has no Android
// implementation. Android registers its own Live Update sink in
// `src/glanceable-android/register.ts`.
import { addUserInteractionListener } from 'expo-widgets';

import { i18n } from '@/i18n';
import { getGlanceableDelivery, registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import {
  getLiveActivityEnabled,
  subscribeLiveActivityEnabled,
} from '@/lib/glanceable/live-activity-switch';

import { adoptPushStartedActivity } from './adopt-activity';
import { refreshActiveAgentsLiveActivityCopy } from './active-agents-live-activity';
import { refreshActiveAgentsWidgetCopy } from './active-agents-widget';
import { handleGlanceableInteraction } from './interaction';
import { iosSink } from './ios-sink';
import { registerWidgetActionHandling } from './widget-actions';
import { ensureWidgetLogo } from './widget-logo';

type InteractionSubscription = ReturnType<typeof addUserInteractionListener>;

/**
 * The one press subscription for this process lifetime, and the one owner of
 * the Live Activity's `approve` and `open` targets.
 *
 * expo-widgets attaches its native `NotificationCenter` observer when the first
 * JS listener subscribes and detaches it when the last one leaves
 * (`WidgetsModule.OnStartObserving`), so the handle is held in module scope
 * rather than dropped at the call site.
 *
 * The Lock Screen card and its Apple Watch mirror report the same `approve`
 * target, so a second listener for that target would run two answer flows for
 * one press; `handleGlanceableInteraction` owns both targets alone. It answers
 * through the recorded ask (`runGlanceableApprove`), which is also what gates
 * the control (`canApprove`), so the press and the button can never disagree.
 */
let interactionSubscription: InteractionSubscription | null = null;

/** Subscribe once; a second call is a no-op. */
function subscribeToInteractions(): void {
  if (interactionSubscription !== null) {
    return;
  }
  interactionSubscription = addUserInteractionListener(event => {
    // The press is answered in the background too, where a rejected promise has
    // nowhere to surface; the handler classifies its own failures.
    void handleGlanceableInteraction(event);
  });
}

if (Platform.OS === 'ios') {
  // Subscribe before anything slower below: a press only reaches JavaScript
  // while the native observer is attached, and the observer is attached from
  // this subscription.
  subscribeToInteractions();

  // Registers the iOS Live Activity and widget sink at import time. The root
  // layout imports this file on both platforms; Android owns
  // glanceable-android/register. Never create a React dependency here: the
  // publisher is plain state, and widgets get translated copy through the sink,
  // not through a mounted component tree.
  registerGlanceableSink(iosSink);

  // Widget App Intent buttons: the live subscription answers a press while this
  // process is up, and the launch sweep picks up a press that patched the
  // timeline before JS subscribed. Its listener filters on the Home Screen
  // widget's press marker, while the subscription above owns the Live Activity's
  // `approve` and `open` targets, so a press is answered by exactly one of them.
  registerWidgetActionHandling();

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
