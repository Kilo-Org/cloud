import { addUserInteractionListener, type UserInteractionEvent } from 'expo-widgets';
import { Linking } from 'react-native';

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

/**
 * One press: the action its entry carries and the entry's date, which is what
 * identifies the entry — the App Intent merges the press marker into the
 * pressed entry's props and never touches its date, so a press read at one
 * moment can be matched against the timeline read at another.
 */
type PressedEntry = { date: number; action: GlanceableWidgetAction };

/**
 * The pressed entry a user-interaction event maps to, or null when the event
 * belongs to another surface or no entry still carries a marker.
 */
function pressedEntryForEvent(
  event: Pick<UserInteractionEvent, 'source'>,
  timeline: readonly { date?: Date; props: WidgetProps | null | undefined }[]
): PressedEntry | null {
  // A Live Activity button or another widget kind reports its own source; only
  // this widget's press markers are ours to run.
  if (event.source !== WIDGET_NAME) {
    return null;
  }
  for (const entry of timeline) {
    const action = pendingActionOf(entry.props);
    if (action !== null) {
      // A timeline read always carries the entry's date; the fallback keeps a
      // hand-built entry from a caller out of the key, and no production read
      // reaches it.
      return { date: entry.date?.getTime() ?? 0, action };
    }
  }
  return null;
}

/** Map a user-interaction event to the action the pressed entry carries. */
export function pendingActionForEvent(
  event: Pick<UserInteractionEvent, 'source'>,
  timeline: readonly { props: WidgetProps | null | undefined }[]
): GlanceableWidgetAction | null {
  return pressedEntryForEvent(event, timeline)?.action ?? null;
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
 * Set by a press that lands while a pass is in flight. The running sweep owes
 * such a press a pass of its own rather than returning, or the tap would only
 * be answered at the next launch or foreground.
 */
let resweepRequested = false;

/**
 * The presses a live listener read out of the timeline while a pass was in
 * flight. Each is held with the action it named, because the marker itself does
 * not survive to the follow-up pass: the running pass's clearing write replaces
 * the timeline it read, and the answered action's own republish (`iosSink` or
 * `republishWidgetProps`) replaces it again — both write whole timelines built
 * from a snapshot, so a marker patched in after the read is gone.
 */
let carriedPresses: PressedEntry[] = [];

/**
 * The delivery reads a mid-pass press started, still in flight. The sweep waits
 * them out before it decides whether to stop: a read that settles after the
 * pass it raced would place its press in `carriedPresses` with no pass left to
 * answer it, so the tap would only be answered at the next launch or foreground.
 */
let carriesInFlight: Promise<void>[] = [];

/**
 * Wait out every delivery read started so far, plus any that start while
 * waiting: a press that lands during the wait is still owed this sweep a pass.
 */
async function settleCarries(): Promise<void> {
  while (carriesInFlight.length > 0) {
    const inFlight = carriesInFlight;
    carriesInFlight = [];
    // eslint-disable-next-line no-await-in-loop -- a press that lands during the wait joins the next batch
    await Promise.all(inFlight);
  }
}

/** Read and clear the presses held from mid-pass. */
function takeCarriedPresses(): PressedEntry[] {
  const carried = carriedPresses;
  carriedPresses = [];
  return carried;
}

/**
 * Hold the press a live interaction event maps to, reading the timeline now
 * rather than after the running pass: the pass's own writes are what take the
 * marker away. A read failure yields nothing to hold, which leaves the pass
 * queued for this press to read the timeline again.
 */
async function carryPendingPress(
  event: Pick<UserInteractionEvent, 'source'> | undefined
): Promise<void> {
  if (event === undefined) {
    return;
  }
  try {
    const press = pressedEntryForEvent(event, await ActiveAgentsWidget.getTimeline());
    if (
      press !== null &&
      !carriedPresses.some(
        carried => carried.date === press.date && carried.action === press.action
      )
    ) {
      carriedPresses.push(press);
    }
  } catch {
    // A native timeline read failure must not reject into the listener's
    // fire-and-forget call.
  }
}

/** Read and clear the queued re-sweep request, if a press asked for one. */
function takeResweepRequest(): boolean {
  const requested = resweepRequested;
  resweepRequested = false;
  return requested;
}

/**
 * One pass: run every press the timeline still carries, plus every press held
 * from a read taken while a previous pass was in flight. The run set and the
 * clearing write come from a single read, and the write is issued before any
 * action runs, so a marker the read saw is run and cleared together: a press is
 * never cleared without being answered. A held press has no marker left to
 * clear — the writes it raced already took it — so it is answered from the held
 * read, which is dropped when this read still carries its marker so the same
 * press never runs twice. The marker is cleared before the action is invoked, so
 * a crash mid-action reads as a dropped press instead of a repeated one, and the
 * widget drops its "Approving…" line immediately (the write reloads the
 * timelines).
 */
async function sweepPendingActions(): Promise<void> {
  const timeline = await ActiveAgentsWidget.getTimeline();
  const pending = new Map<number, WidgetAction>();
  const pressed: PressedEntry[] = [];
  for (const [index, entry] of timeline.entries()) {
    const action = pendingActionOf(entry.props);
    if (action !== null) {
      pending.set(index, action);
      pressed.push({ date: entry.date.getTime(), action });
    }
  }
  const carried = takeCarriedPresses().filter(
    press => !pressed.some(read => read.date === press.date && read.action === press.action)
  );
  if (pending.size > 0) {
    ActiveAgentsWidget.updateTimeline(
      timeline.map((entry, index) =>
        pending.has(index) ? { date: entry.date, props: stripPendingAction(entry.props) } : entry
      )
    );
  }
  for (const action of [...pending.values(), ...carried.map(press => press.action)]) {
    // Sequential by design: each action can republish the surface, and two
    // overlapping republishes could push the props out of order.
    // eslint-disable-next-line no-await-in-loop -- one answer on screen at a time
    await performWidgetAction(action);
  }
}

/**
 * The sweep: run every press the timeline still carries, and keep sweeping
 * while a press asked for another pass. A press the live listener delivers
 * while a pass is in flight sets `resweepRequested` and is held from the
 * timeline read taken at delivery, so the follow-up pass answers it even though
 * the running pass's own writes have since erased its marker. The sweep waits
 * for that read before it decides to stop, so a read that settles after the
 * pass it raced still gets its pass.
 *
 * The press marker rides the `expo-widgets` widget timeline the App Intent
 * patches, and that timeline exists only on iOS: `expo-widgets` has no widget
 * timeline or interaction events elsewhere, so this reads an empty timeline and
 * runs nothing where the surface does not exist. Android answers the same press
 * from the widget host's headless task (`glanceable-android/register.ts`).
 * Nothing here forks on the platform, so both platforms run the same code.
 *
 * `event` is the live path's interaction: the sweep then only runs when the
 * event's source carries one of this widget's press markers — a Live Activity
 * button or another widget kind reports its own source and owns no marker
 * here. The launch and foreground sweeps pass no event and run every marker.
 */
export async function runPendingWidgetActions(
  event?: Pick<UserInteractionEvent, 'source'>
): Promise<void> {
  if (sweeping) {
    resweepRequested = true;
    const carry = carryPendingPress(event);
    carriesInFlight.push(carry);
    await carry;
    return;
  }
  sweeping = true;
  try {
    if (event !== undefined) {
      const timeline = await ActiveAgentsWidget.getTimeline();
      if (pendingActionForEvent(event, timeline) === null) {
        return;
      }
    }
    do {
      // eslint-disable-next-line no-await-in-loop -- a pass republishes the surface, so passes must not overlap
      await sweepPendingActions();
      // The running pass may have finished while a press it has to answer was
      // still reading the timeline. Wait that read out before deciding to stop,
      // so the pass below answers the held press instead of the next launch.
      // eslint-disable-next-line no-await-in-loop -- the follow-up pass owes these reads their answer
      await settleCarries();
    } while (takeResweepRequest());
  } catch {
    // A native timeline read/write failure must not throw into the caller;
    // the next launch or foreground sweep retries.
  } finally {
    sweeping = false;
  }
}

/**
 * The live listener and which registration owns it, mirroring
 * `registerGlanceableApproveAction`: a second registration must not add a
 * second listener — two sweeps would race the same markers — and only the
 * registration still holding this id may remove it.
 */
let subscription: ReturnType<typeof addUserInteractionListener> | null = null;
let registrationId = 0;

/**
 * Subscribe the live path and sweep once at startup. The root layout imports
 * this on both platforms, and the module stays platform-neutral: the press
 * marker rides the `expo-widgets` widget timeline, which exists only on iOS, so
 * a call elsewhere subscribes to an inert listener and sweeps an empty
 * timeline. The capability check therefore lives once, at the registration
 * boundary (`glanceable-ios/register.ts`, the same place the sibling
 * `registerGlanceableApproveAction` gets its iOS scope); Android runs the same
 * action from the widget host's headless task (`glanceable-android/register.ts`).
 *
 * The one user-visible difference is when the action runs: Android's task
 * answers the press in the background the moment it is tapped, while an iOS
 * press is answered at this process's next launch or foreground, because an
 * App Intent cannot run this JS in a cold process. Both draw the press's
 * progress line immediately, and both run the same shared action
 * (`lib/glanceable/widget-actions`).
 *
 * A second call replaces neither the listener nor the ownership: the returned
 * unsubscribe removes the listener only while its own registration still owns
 * it.
 */
export function registerWidgetActionHandling(): () => void {
  const id = (registrationId += 1);
  subscription ??= addUserInteractionListener(event => {
    void runPendingWidgetActions(event);
  });
  // A press that patched the marker before JS subscribed (the app was dead, or
  // still launching) is picked up by this launch sweep instead of being lost.
  void runPendingWidgetActions();
  return () => {
    // A later registration owns the listener now, so clearing it here would
    // disable the press handling that registration installed.
    if (id !== registrationId) {
      return;
    }
    registrationId += 1;
    subscription?.remove();
    subscription = null;
  };
}
