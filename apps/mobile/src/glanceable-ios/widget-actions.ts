import { addUserInteractionListener, type UserInteractionEvent } from 'expo-widgets';
import { Linking, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { getLastGlanceableSnapshot } from '@/lib/glanceable/persist';
import { getSurfaceExtras, setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import {
  failureFeedback,
  runWidgetAction,
  type WidgetAction,
} from '@/lib/glanceable/widget-actions';

import { ActiveAgentsWidget, WIDGET_NAME, type WidgetProps } from './active-agents-widget';
import {
  buildGlanceableViewProps,
  type GlanceableWidgetAction,
  toWidgetProps,
  widgetTimelineFrames,
} from './view-props';

/**
 * Handling for the widget's in-place App Intent buttons.
 *
 * Two paths, because the intent runs in the widget extension and can patch the
 * timeline before this process has JS alive at all:
 *
 * 1. Live — subscribe to `onExpoWidgetsUserInteraction` at app start. The
 *    intent has already merged the press marker (`pendingAction`) into the
 *    pressed entry's props before the notification arrives, so the marker
 *    itself maps the event's `source`/`target` to the action to run.
 * 2. Sweep — on app launch and on every foreground of the agents tab, read the
 *    stored timeline and run any entry whose props carry the marker. This
 *    covers a cold start, where the intent patched the marker long before JS
 *    subscribed.
 *
 * Both paths funnel through one sweep that clears the marker from the timeline
 * before invoking the action, so a crash mid-action — or the foreground sweep
 * racing a live listener — can never run the same press twice.
 */

/** Read the press marker out of a timeline entry's props, if one is pending. */
export function pendingActionOf(
  props: WidgetProps | null | undefined
): GlanceableWidgetAction | null {
  const pendingAction = props?.pendingAction;
  return pendingAction === 'approve' || pendingAction === 'new-agent' ? pendingAction : null;
}

/** The pressed entry's props without the marker, in the form the timeline stores. */
function stripPendingAction(props: WidgetProps | null | undefined): WidgetProps {
  const {
    pendingAction: _pendingAction,
    pendingActionVisible: _pendingActionVisible,
    ...rest
  } = props ?? {};
  return rest;
}

/** Map a user-interaction event to the action the pressed entry carries. */
export function pendingActionForEvent(
  event: Pick<UserInteractionEvent, 'source'>,
  timeline: readonly { props: WidgetProps | null | undefined }[]
): GlanceableWidgetAction | null {
  // A Live Activity button or another widget kind reports its own source; only
  // this widget's press markers are ours to run.
  if (event.source !== WIDGET_NAME) {
    return null;
  }
  for (const entry of timeline) {
    const action = pendingActionOf(entry.props);
    if (action !== null) {
      return action;
    }
  }
  return null;
}

/**
 * Rebuild the widget props from the last snapshot and replace the timeline.
 *
 * The props carry the surface extras (the press's failure line), so this runs
 * only for a press that did not republish the tray. `updateSnapshot` leaves a
 * single frame behind, which would drop the delayed and expiry frames the sink
 * wrote: a widget nothing refreshes after this press would then keep claiming
 * the line as current past `expiresAt`. Hand WidgetKit the same frames the sink
 * does; `null` means a terminal blank, whose single frame stands.
 */
function republishWidgetProps(): void {
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null) {
    return;
  }
  const translate = (key: string): string => i18n.t(key);
  const props = toWidgetProps(buildGlanceableViewProps(snapshot, {}, translate));
  ActiveAgentsWidget.updateSnapshot(props);
  const frames = widgetTimelineFrames(snapshot, props, translate);
  if (frames !== null) {
    ActiveAgentsWidget.updateTimeline(frames);
  }
}

/** Where an unfinished action lands: the same agents list the body tap opens. */
const OPEN_AGENTS_URI = 'kiloapp:///cloud/sessions';
/** Where a create with nothing to start from lands: the new-session screen. */
const OPEN_NEW_AGENT_URI = 'kiloapp://agent-chat/new';

/**
 * Run one press. `runWidgetAction` republishes the tray through every sink on
 * success, which writes fresh widget props and is the answer the widget shows;
 * a failed call pushes the action's own couldn't-do-it feedback here, because no
 * republish happens. An action that cannot complete in place (`none`:
 * nothing to act on or no draft/repository/model to start from;
 * `no-permission`: the agent asked a free-form question the widget must never
 * invent an answer to) hands the user to the app instead — the same
 * destinations the Android twin opens (`glanceable-android/register.ts`), so
 * the press never dead-ends silently on either platform.
 */
async function performWidgetAction(action: WidgetAction): Promise<void> {
  // Retire the previous press's failure line before this one runs. A success
  // republishes the tray from inside `runWidgetAction`, and the builder reads
  // this module's extras while it does: a leftover couldn't-approve line would
  // ride out with the fresh counts and show an error for an approval that just
  // worked. Clearing up front also makes every outcome below the only writer.
  // The sweep runs its presses sequentially, so no sibling press can observe
  // the gap.
  setSurfaceExtras({ ...getSurfaceExtras(), actionFeedback: null });
  const result = await runWidgetAction(action);
  if (result.kind === 'approved' || result.kind === 'created') {
    return;
  }
  setSurfaceExtras({
    ...getSurfaceExtras(),
    // The failure line is the action's own retry copy, so the button that
    // failed stays offered and the body tap still opens Kilo.
    actionFeedback: result.kind === 'failed' ? failureFeedback(action) : null,
  });
  republishWidgetProps();
  // Nothing to act on, or the wait is a free-form question: the action hands
  // the user to the app. The create action lands on the new-session screen
  // when it had no draft or repository to start from. A failed call stays on
  // the widget, whose retry row and body tap remain offered.
  if (result.kind === 'none' || result.kind === 'no-permission') {
    const uri = action === 'approve' ? OPEN_AGENTS_URI : OPEN_NEW_AGENT_URI;
    try {
      await Linking.openURL(uri);
    } catch {
      // A host that cannot bring the app up leaves the settled widget on
      // screen; the sweep itself must not fail on the open.
    }
  }
}

let sweeping = false;

/**
 * The sweep: run every press the timeline still carries. The marker is cleared
 * from the stored timeline before the action is invoked, so a crash mid-action
 * reads as a dropped press instead of a repeated one, and the widget drops its
 * "Approving…" line immediately (the write reloads the timelines).
 *
 * `event` is the live path's interaction: the sweep then only runs when the
 * event's source carries one of this widget's press markers — a Live Activity
 * button or another widget kind reports its own source and owns no marker
 * here. The launch and foreground sweeps pass no event and run every marker.
 */
export async function runPendingWidgetActions(
  event?: Pick<UserInteractionEvent, 'source'>
): Promise<void> {
  if (Platform.OS !== 'ios' || sweeping) {
    return;
  }
  sweeping = true;
  try {
    const timeline = await ActiveAgentsWidget.getTimeline();
    if (event !== undefined && pendingActionForEvent(event, timeline) === null) {
      return;
    }
    const pending = new Map<number, WidgetAction>();
    for (const [index, entry] of timeline.entries()) {
      const action = pendingActionOf(entry.props);
      if (action !== null) {
        pending.set(index, action);
      }
    }
    if (pending.size === 0) {
      return;
    }
    ActiveAgentsWidget.updateTimeline(
      timeline.map((entry, index) =>
        pending.has(index) ? { date: entry.date, props: stripPendingAction(entry.props) } : entry
      )
    );
    for (const action of pending.values()) {
      // Sequential by design: each action can republish the surface, and two
      // overlapping republishes could push the props out of order.
      // eslint-disable-next-line no-await-in-loop -- one answer on screen at a time
      await performWidgetAction(action);
    }
  } catch {
    // A native timeline read/write failure must not throw into the caller;
    // the next launch or foreground sweep retries.
  } finally {
    sweeping = false;
  }
}

/**
 * Subscribe the live path and sweep once at startup. The root layout imports
 * this on both platforms; iOS owns the registration, and the sweep itself is
 * guarded to iOS too.
 */
export function registerWidgetActionHandling(): void {
  if (Platform.OS !== 'ios') {
    return;
  }
  addUserInteractionListener(event => {
    void runPendingWidgetActions(event);
  });
  // A press that patched the marker before JS subscribed (the app was dead, or
  // still launching) is picked up by this launch sweep instead of being lost.
  void runPendingWidgetActions();
}
