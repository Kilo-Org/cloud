// iOS-only by capability: `expo-widgets` bridges WidgetKit/ActivityKit, which
// Android has no equivalent of. Android answers the same press through the Live
// Update notification's broadcast and WorkManager headless JS
// (src/glanceable-android/approve-task.ts); both answer through the shared
// src/lib/glanceable/approve-ask.ts.
import { addUserInteractionListener } from 'expo-widgets';

/**
 * The Active Agents Live Activity's Approve control.
 *
 * The widget extension renders the Live Activity in a separate process and
 * `expo-widgets` bridges a `Button` press back here as an interaction event:
 * the native `LiveActivityUserInteraction` intent runs in the app process and
 * emits `onExpoWidgetsUserInteraction` with the button's `target` and a
 * `source`. This module keeps the target the event must carry and routes a
 * match to the same front-approval service the phone uses.
 *
 * The event's `source` is NOT the name passed to `createLiveActivity`. The
 * native layout is rendered with `name: context.activityID`
 * (`expo-widgets/ios/Widgets/WidgetLiveActivity.swift`, the banner and every
 * Dynamic Island section), and the `.liveActivity` branch of
 * `WidgetsDynamicView` copies that `name` onto the button as its `source`
 * (`expo-widgets/ios/Widgets/DynamicView.swift`). So the source is the
 * ActivityKit instance id, a UUID minted per activity: it cannot be written
 * into the stringified layout, and it is not known when the handler runs.
 * Matching on it would therefore never fire a press. The `approve` target is
 * the only `target` any layout in this app draws, so it alone identifies the
 * press; `layout-copy.test.ts` keeps the layout's literal equal to
 * `APPROVE_TARGET`, and a second `approve` control would be a deliberate
 * change to that contract.
 */

/** The target string the layout's Approve button carries. */
export const APPROVE_TARGET = 'approve';

/**
 * The Live Activity's registration name (`createLiveActivity`). The activity's
 * content state carries it, and it is what makes the card mirror into the Apple
 * Watch Smart Stack. The native press is reported under the activity id, never
 * this name.
 */
export const ACTIVE_AGENTS_LIVE_ACTIVITY_NAME = 'ActiveAgentsLiveActivity';

/**
 * The interaction event's shape. `source` is the native activity id, carried by
 * `onExpoWidgetsUserInteraction`; the handler matches on `target` alone (see the
 * note above), and the field stays on the type so a caller passes the real
 * event rather than a hand-built one.
 */
export type GlanceableUserInteraction = { source: string; target: string };

/**
 * The approve callback, replaced rather than duplicated by a second
 * registration, and the single live listener. Both are module state because
 * the widget process can deliver an event at any time after registration.
 */
let approveAction: (() => Promise<void>) | null = null;
let subscription: ReturnType<typeof addUserInteractionListener> | null = null;
/**
 * Which registration owns the callback and the listener. A later registration
 * replaces the callback, and only the registration still holding this id may
 * clear them.
 */
let registrationId = 0;

/**
 * Route one interaction event to `approve` when it is this Live Activity's
 * Approve button, and ignore every other event.
 *
 * A rejection is swallowed: the interaction originates on the Lock Screen or
 * the Watch, which has no error surface, so the card simply keeps its counts
 * until the next snapshot update. The control stays while the wait remains, so
 * pressing it again is the retry; the failure itself is already visible on the
 * phone the approval was issued against.
 */
export async function handleApproveInteraction(
  event: GlanceableUserInteraction,
  approve: () => Promise<void>
): Promise<void> {
  if (event.target !== APPROVE_TARGET) {
    return;
  }
  try {
    await approve();
  } catch {
    // The surface keeps its counts; nothing here can retry or report.
  }
}

/**
 * Subscribe the approve handler once and return its unsubscribe.
 *
 * A second call replaces the callback without adding a second listener, so a
 * duplicated module evaluation (or a re-registration) can never run the
 * approval twice for one press.
 */
export function registerGlanceableApproveAction(approve: () => Promise<void>): () => void {
  const id = (registrationId += 1);
  approveAction = approve;
  subscription ??= addUserInteractionListener(event => {
    const current = approveAction;
    if (current !== null) {
      void handleApproveInteraction(event, current);
    }
  });
  return () => {
    // A later registration replaced the callback and owns the listener now, so
    // clearing them here would disable an approval this call no longer owns.
    if (id !== registrationId) {
      return;
    }
    registrationId += 1;
    subscription?.remove();
    subscription = null;
    approveAction = null;
  };
}
