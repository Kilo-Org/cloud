import {
  GLANCEABLE_IDLE_ONLY_MS,
  GLANCEABLE_TERMINAL_MS,
  isEligibleGlanceableWork,
  isIdleOnlyGlanceableWork,
  isStartableGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';
import { after, type LiveActivity } from 'expo-widgets';

import { i18n } from '@/i18n';
import { getGlanceableDelivery, type GlanceableSink } from '@/lib/glanceable/sink-registry';
import { getLiveActivityEnabled } from '@/lib/glanceable/live-activity-switch';

import { ActiveAgentsLiveActivity } from './active-agents-live-activity';
import { ActiveAgentsWidget } from './active-agents-widget';
import {
  buildExpiredWidgetProps,
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  toWidgetProps,
} from './view-props';

/** Open-agents destination, kept in step with the inlined widget URL. */
const OPEN_AGENTS_URL = 'kiloapp:///cloud/sessions';

type Activity = LiveActivity<Partial<GlanceableLiveActivityContentState>>;

let activityKitDeniedState = false;
let activity: Activity | null = null;
let revision = 0;
/** In-flight native `update`; `end` awaits it so its contentDate is never older. */
let inFlightUpdate: Promise<void> | null = null;
let lastProps: Partial<GlanceableLiveActivityContentState> | null = null;

function translate(key: string): string {
  return i18n.t(key);
}

/**
 * True only when ActivityKit reported the surface unavailable. expo-widgets
 * surfaces its native `LiveActivitiesNotSupportedException` as an Error whose
 * `code` is the snake-cased class name. Any other start/instances failure is
 * transient and must not mark the surface permanently denied.
 */
function isActivityKitUnavailable(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED'
  );
}

/** Recheck native state even when JavaScript missed the remote terminal snapshot. */
function refreshActivity(): boolean {
  try {
    if (activity !== null) {
      const { state } = activity.getInfo();
      if (state !== 'active' && state !== 'stale') {
        getGlanceableDelivery().cleanupTokens('activity', readEndingToken(activity));
        activity = null;
        inFlightUpdate = null;
        lastProps = null;
        revision = 0;
      }
    }
    // Wrappers change on discovery; only native IDs identify pending ends.
    const live = ActiveAgentsLiveActivity.getInstances().filter(
      instance => !endingActivities.has(instance.getInfo().id)
    );
    activity ??= live.at(-1) ?? null;
    // Exactly one card may ever be on screen. A push-to-start that raced a
    // local start, or a card left behind by an earlier organization scope, is
    // adopted by nobody: it is never updated and never ended, so it sits frozen
    // on the Lock Screen for the whole 8 hour lifetime. Retire every instance
    // except the adopted one here, in the one native read every path shares.
    // Which one is adopted does not matter — native order is a dictionary
    // order, not a start order — only that the others do not survive it.
    const keptId = activity?.getInfo().id;
    for (const instance of live) {
      const id = instance.getInfo().id;
      if (id !== keptId) {
        endExtra(instance, id);
      }
    }
    return true;
  } catch (error) {
    if (isActivityKitUnavailable(error)) {
      activityKitDeniedState = true;
    }
    // Do not update an unverified cached handle or start a duplicate on a read failure.
    return false;
  }
}

async function readEndingToken(instance: Activity): Promise<string | null> {
  try {
    return await instance.getPushToken();
  } catch {
    // Recorded tokens still need cleanup when the native lookup fails.
    return null;
  }
}

type EndIntent = {
  /** Milliseconds ActivityKit retains the card, or null to dismiss it at once. */
  dismissMs: number | null;
  props: Partial<GlanceableLiveActivityContentState> | null;
};
type EndingActivity = {
  id: string;
  instance: Activity;
  update: Promise<void> | null;
  token: Promise<string | null>;
  intent: EndIntent;
  pending: Promise<void> | null;
};
// Only pending native submissions live in JS. Native discovery owns terminal visibility.
const endingActivities = new Map<string, EndingActivity>();

async function finishEnd(ending: EndingActivity): Promise<void> {
  let completed = false;
  try {
    try {
      await ending.update;
    } catch {
      // A rejected update must not block the end; its contentDate still advances.
    }
    await ending.token;
    // Read the latest intent at the native boundary. Privacy can supersede an
    // empty snapshot during either await, including an already-submitted end.
    // The retention window is measured from here, so the awaits never eat it.
    for (;;) {
      const intent = ending.intent;
      // eslint-disable-next-line no-await-in-loop -- serialize a privacy dismissal after an in-flight native end
      await ending.instance.end(
        intent.dismissMs === null ? 'immediate' : after(new Date(Date.now() + intent.dismissMs)),
        intent.props ?? undefined,
        new Date()
      );
      if (intent === ending.intent) {
        break;
      }
    }
    completed = true;
  } catch (error) {
    // Native reports missing IDs as dismissed; only confirmed absence settles a failed end.
    if (ending.instance.getInfo().state !== 'dismissed') {
      throw error;
    }
    completed = true;
  } finally {
    ending.pending = null;
    if (completed) {
      endingActivities.delete(ending.id);
    }
  }
}

async function scheduleEnd(ending: EndingActivity): Promise<void> {
  if (ending.pending !== null) {
    return;
  }
  ending.pending = finishEnd(ending);
  try {
    await ending.pending;
  } catch {
    // Foreground publication is best-effort; background callers await the original task.
  }
}

/**
 * End one activity this sink does not own, at once. Its push token belongs to
 * an earlier process or to a push-to-start, so no local token cleanup runs
 * here: the server drops the row when APNs reports the activity ended.
 */
function endExtra(instance: Activity, id: string): void {
  const ending: EndingActivity = {
    id,
    instance,
    update: null,
    token: readEndingToken(instance),
    intent: { dismissMs: null, props: null },
    pending: null,
  };
  endingActivities.set(id, ending);
  void scheduleEnd(ending);
}

function endNow(
  dismissMs: number | null = null,
  props: Partial<GlanceableLiveActivityContentState> | null = lastProps
): void {
  const targets = new Map<string, Activity>();
  if (dismissMs === null) {
    try {
      // Privacy must include terminal content, even after JS state was discarded.
      for (const instance of ActiveAgentsLiveActivity.getInstances(true)) {
        targets.set(instance.getInfo().id, instance);
      }
    } catch (error) {
      if (isActivityKitUnavailable(error)) {
        activityKitDeniedState = true;
      }
    }
  } else if (!refreshActivity()) {
    return;
  }
  const currentId = activity?.getInfo().id;
  if (activity !== null && currentId !== undefined) {
    targets.set(currentId, activity);
  }
  for (const [id, instance] of targets) {
    if (!endingActivities.has(id)) {
      const token = readEndingToken(instance);
      // Capture before end, and retire tokens before fresh work can register.
      getGlanceableDelivery().cleanupTokens('activity', token);
      endingActivities.set(id, {
        id,
        instance,
        update: id === currentId ? inFlightUpdate : null,
        token,
        intent: { dismissMs, props },
        pending: null,
      });
    }
  }
  activity = null;
  inFlightUpdate = null;
  lastProps = null;
  revision = 0;
  for (const ending of endingActivities.values()) {
    if (
      dismissMs === null &&
      (ending.intent.dismissMs !== null || (props !== null && props !== ending.intent.props))
    ) {
      ending.intent = { dismissMs: null, props: props ?? ending.intent.props };
    }
    void scheduleEnd(ending);
  }
  if (dismissMs === null && endingActivities.size === 0) {
    getGlanceableDelivery().cleanupTokens('activity');
  }
}

/** True once ActivityKit reported the surface unavailable (see slice psh for the alert). */
export function getActivityKitDenied(): boolean {
  return activityKitDeniedState;
}

/**
 * Re-probe ActivityKit after the user may have re-enabled it in Settings.
 * Clears the denied latch when the surface is available again and returns true;
 * keeps the latch and returns false when it is still unavailable (or the probe
 * is a transient read failure). The caller then re-emits eligible work through
 * `startOrUpdate`, whose `start` re-checks availability authoritatively.
 */
export function clearActivityKitDeniedIfAvailable(): boolean {
  if (!activityKitDeniedState) {
    return false;
  }
  try {
    ActiveAgentsLiveActivity.getInstances();
    activityKitDeniedState = false;
    return true;
  } catch {
    // Still unavailable (or transient): keep the latch.
    return false;
  }
}

/** Test-only: drop all sink state between cases. */
export function _resetIosSinkForTests(): void {
  activityKitDeniedState = false;
  activity = null;
  revision = 0;
  inFlightUpdate = null;
  lastProps = null;
  endingActivities.clear();
}

export const iosSink: GlanceableSink = {
  async waitForNativeTerminal() {
    await Promise.all(
      [...endingActivities.values()].map((ending): Promise<void> | null => ending.pending)
    );
  },

  publish(snapshot) {
    const props = toWidgetProps(buildGlanceableViewProps(snapshot, {}, translate));
    ActiveAgentsWidget.updateSnapshot(props);
    // updateSnapshot replaces the timeline, so terminal copy needs no expiry frame.
    if (snapshot.status !== 'signed_out' && snapshot.status !== 'privacy') {
      ActiveAgentsWidget.updateTimeline([
        { date: new Date(), props },
        { date: new Date(snapshot.expiresAt), props: buildExpiredWidgetProps(snapshot, translate) },
      ]);
    }
    const contentState = buildGlanceableLiveActivityContentState(snapshot);
    if (!isEligibleGlanceableWork(snapshot)) {
      // ActivityKit owns removal after this call, even if JavaScript stops.
      // The after-date retains Lock Screen content, not the Dynamic Island.
      const immediate = snapshot.status === 'signed_out' || snapshot.status === 'privacy';
      endNow(immediate ? null : GLANCEABLE_TERMINAL_MS, contentState);
      return;
    }
    // Never start here. Recheck cached native work and preserve update/end ordering.
    if (refreshActivity() && activity !== null) {
      lastProps = contentState;
      inFlightUpdate = activity.update(lastProps);
      if (isIdleOnlyGlanceableWork(snapshot)) {
        // Everything went idle: hand ActivityKit the dismissal date and stop
        // owning the surface. A JavaScript timer would never fire — the app is
        // asleep whenever this matters — and an idle agent produces no further
        // snapshot to check a deadline against. `endNow` awaits the update
        // above, so the card keeps the idle counts until it is removed. Work
        // resuming inside the window starts a fresh card, and `startOrUpdate`
        // dismisses this one first.
        endNow(GLANCEABLE_IDLE_ONLY_MS, contentState);
      }
    }
  },

  startOrUpdate(snapshot, ctx) {
    // The in-app switch is checked first: it is the one the user set here, and
    // honoring it costs no native call. ActivityKit's own switch still decides
    // the rest, and `start` remains the authority on it.
    if (
      !getLiveActivityEnabled() ||
      activityKitDeniedState ||
      !isEligibleGlanceableWork(snapshot) ||
      !refreshActivity()
    ) {
      return;
    }

    const contentState = buildGlanceableLiveActivityContentState(snapshot);

    if (activity === null) {
      // Idle work never raises a card. It keeps one alive once real work put it
      // there, and `publish` hands ActivityKit the idle dismissal date.
      if (!isStartableGlanceableWork(snapshot)) {
        return;
      }
      // Work resumed inside an idle window, so the card it replaces is already
      // `ended` and waiting out its dismissal date. Native discovery hides an
      // ended card, and only a second, immediate end removes it: dismiss it
      // here, keeping its own content, so two cards never share the screen.
      endNow(null, null);
      try {
        activity = ActiveAgentsLiveActivity.start(contentState, OPEN_AGENTS_URL);
        inFlightUpdate = null;
      } catch (error) {
        // Only ActivityKit unavailability is permanent; transient starts retry later.
        if (isActivityKitUnavailable(error)) {
          activityKitDeniedState = true;
        }
        return;
      }
      lastProps = contentState;
      revision = snapshot.revision;
      getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId, activity);
      return;
    }

    // publish can adopt an activity before this method sees it. Bind its token
    // listener here too; delivery deduplicates the sink's stable native handle.
    getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId, activity);
    // The publisher coalesces and guards revisions, but keep the sink monotonic
    // so a late or replayed emit can never move the surface backwards.
    if (snapshot.revision <= revision) {
      return;
    }
    lastProps = contentState;
    inFlightUpdate = activity.update(contentState);
    revision = snapshot.revision;
  },

  endImmediate() {
    endNow();
  },
};
