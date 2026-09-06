import {
  GLANCEABLE_IDLE_ONLY_MS,
  GLANCEABLE_STALE_MS,
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
  isIdleOnlyGlanceableWork,
  isStartableGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { i18n } from '@/i18n';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
} from '@/lib/glanceable/sink-registry';
import { getLiveActivityEnabled } from '@/lib/glanceable/live-activity-switch';

import { ActiveAgentsLiveActivity, OPEN_AGENTS_URL } from './active-agents-live-activity';
import {
  type Activity,
  endExtra,
  endingActivities,
  readEndingToken,
  scheduleEnd,
  settleEnds,
} from './ending-activities';
import { ActiveAgentsWidget } from './active-agents-widget';
import {
  buildExpiredWidgetProps,
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  toWidgetProps,
} from './view-props';

/** ActivityKit takes the stale window in seconds. */
const STALE_AFTER_SECONDS = GLANCEABLE_STALE_MS / 1000;

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

/** A start waiting on a dismissal, so a replacement card never overlaps the one it replaces. */
let pendingStart: Promise<void> | null = null;
/** What that deferred start will raise; a newer snapshot replaces it before it runs. */
let pendingStartInput: {
  contentState: Partial<GlanceableLiveActivityContentState>;
  snapshot: GlanceableAgentsSnapshot;
  ctx: GlanceableSinkContext;
} | null = null;
let pendingStartAt = 0;

/** Raise the card. Shared by the immediate start and the one deferred behind a dismissal. */
function startCard(
  contentState: Partial<GlanceableLiveActivityContentState>,
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext
): void {
  try {
    activity = ActiveAgentsLiveActivity.start(contentState, OPEN_AGENTS_URL, STALE_AFTER_SECONDS);
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

/**
 * End the adopted card. Returns the pending native work, or null when there was
 * nothing to end.
 *
 * `reachEnded` widens the scan to cards ActivityKit has already ended but not
 * yet dismissed. Only a terminal caller may set it: an idle end must never
 * touch a card whose dismissal is already sooner than its own window.
 */
function endNow(
  dismissMs: number | null = null,
  props: Partial<GlanceableLiveActivityContentState> | null = lastProps,
  reachEnded = dismissMs === null
): Promise<void> | null {
  const targets = new Map<string, Activity>();
  if (reachEnded) {
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
    return null;
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
  const pending: Promise<void>[] = [];
  for (const ending of endingActivities.values()) {
    const submitted = ending.intent.dismissMs;
    if (dismissMs === null) {
      if (submitted !== null || (props !== null && props !== ending.intent.props)) {
        ending.intent = { dismissMs: null, props: props ?? ending.intent.props };
      }
    } else if (submitted !== null && dismissMs < submitted) {
      // Work that ended for good outranks the idle window it interrupts: an
      // already-submitted 10 minute dismissal must shrink to the terminal one,
      // or the card keeps idle counts on screen long after the agents are gone.
      ending.intent = { dismissMs, props: props ?? ending.intent.props };
    }
    pending.push(scheduleEnd(ending));
  }
  if (dismissMs === null && endingActivities.size === 0) {
    getGlanceableDelivery().cleanupTokens('activity');
  }
  return pending.length === 0 ? null : settleEnds(pending);
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
  pendingStart = null;
  pendingStartInput = null;
  pendingStartAt = 0;
}

export const iosSink: GlanceableSink = {
  async waitForNativeTerminal() {
    await Promise.all(
      [...endingActivities.values()].map((ending): Promise<void> | null => ending.pending)
    );
    // A replacement card deferred behind a dismissal is part of that terminal work.
    await pendingStart;
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
      // `reachEnded`: work can go empty while an idle card is already counting
      // down its 10 minute window. That card is still on screen and still shows
      // the idle counts, so the terminal window has to reach it.
      void endNow(immediate ? null : GLANCEABLE_TERMINAL_MS, contentState, true);
      return;
    }
    // Never start here. Recheck cached native work and preserve update/end ordering.
    if (refreshActivity() && activity !== null) {
      lastProps = contentState;
      inFlightUpdate = activity.update(lastProps, STALE_AFTER_SECONDS);
      if (isIdleOnlyGlanceableWork(snapshot)) {
        // Everything went idle: hand ActivityKit the dismissal date and stop
        // owning the surface. A JavaScript timer would never fire — the app is
        // asleep whenever this matters — and an idle agent produces no further
        // snapshot to check a deadline against. `endNow` awaits the update
        // above, so the card keeps the idle counts until it is removed. Work
        // resuming inside the window starts a fresh card, and `startOrUpdate`
        // dismisses this one first.
        void endNow(GLANCEABLE_IDLE_ONLY_MS, contentState);
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
      !isEligibleGlanceableWork(snapshot)
    ) {
      return;
    }

    const contentState = buildGlanceableLiveActivityContentState(snapshot);

    if (pendingStart !== null) {
      // A start is already waiting on a dismissal. There is no card to update
      // yet, and raising a second one is the duplicate this sink exists to stop.
      // Hand the waiting start the newer counts so it does not open stale.
      if (isStartableGlanceableWork(snapshot) && snapshot.revision >= pendingStartAt) {
        pendingStartInput = { contentState, snapshot, ctx };
        pendingStartAt = snapshot.revision;
      }
      return;
    }

    if (!refreshActivity()) {
      return;
    }

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
      const dismissal = endNow(null, null);
      if (dismissal !== null) {
        // ActivityKit keeps the ended card on screen until the dismissal lands.
        // Starting before then puts two cards up, so the replacement waits.
        pendingStartInput = { contentState, snapshot, ctx };
        pendingStartAt = snapshot.revision;
        pendingStart = (async () => {
          await dismissal;
          const input = pendingStartInput;
          pendingStart = null;
          pendingStartInput = null;
          pendingStartAt = 0;
          startCard(input.contentState, input.snapshot, input.ctx);
        })();
        return;
      }
      startCard(contentState, snapshot, ctx);
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
    inFlightUpdate = activity.update(contentState, STALE_AFTER_SECONDS);
    revision = snapshot.revision;
  },

  endImmediate() {
    void endNow();
  },
};
