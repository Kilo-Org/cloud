import {
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';
import { type LiveActivity } from 'expo-widgets';

import { i18n } from '@/i18n';
import { getGlanceableDelivery, type GlanceableSink } from '@/lib/glanceable/sink-registry';

import { ActiveAgentsLiveActivity } from './active-agents-live-activity';
import { ActiveAgentsWidget } from './active-agents-widget';
import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  type GlanceableViewProps,
} from './view-props';

/** Open-agents destination, kept in step with the inlined widget URL. */
const OPEN_AGENTS_URL = '/(app)/(tabs)/(2_agents)';

type Activity = LiveActivity<Partial<GlanceableLiveActivityContentState>>;

let activityKitDeniedState = false;
let activity: Activity | null = null;
let revision = 0;
let lastUpdatedAt: string | null = null;
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

/**
 * Adopt the newest ActivityKit instance into the in-memory handle. After a
 * process restart the JS handle is null while ActivityKit still holds the
 * activity, so end/publish must adopt before acting. Returns null when none
 * exists. Only ActivityKit unavailability is permanent; a transient error
 * leaves denial unset so a later call retries.
 */
function adoptExistingActivity(): Activity | null {
  try {
    return ActiveAgentsLiveActivity.getInstances().at(-1) ?? null;
  } catch (error) {
    if (isActivityKitUnavailable(error)) {
      activityKitDeniedState = true;
    }
    return null;
  }
}

function buildExpiredProps(snapshot: GlanceableAgentsSnapshot): Partial<GlanceableViewProps> {
  return buildGlanceableViewProps(
    {
      ...snapshot,
      status: 'expired',
      running: 0,
      needsInput: 0,
      reconnecting: 0,
      eligibleStartedAt: null,
    },
    {},
    translate
  );
}

function endNow(): void {
  // A process restart leaves the JS handle null while ActivityKit still
  // holds the activity; adopt it so the end actually clears the Lock Screen.
  activity ??= adoptExistingActivity();
  if (activity === null) {
    return;
  }
  const contentDate = lastUpdatedAt === null ? undefined : new Date(lastUpdatedAt);
  void activity.end('immediate', lastProps ?? undefined, contentDate);
  activity = null;
  revision = 0;
  getGlanceableDelivery().unregisterTokens();
}

/** True once ActivityKit reported the surface unavailable (see slice psh for the alert). */
export function getActivityKitDenied(): boolean {
  return activityKitDeniedState;
}

/** Test-only: drop all sink state between cases. */
export function _resetIosSinkForTests(): void {
  activityKitDeniedState = false;
  activity = null;
  revision = 0;
  lastUpdatedAt = null;
  lastProps = null;
}

export const iosSink: GlanceableSink = {
  publish(snapshot) {
    const props = buildGlanceableViewProps(snapshot, {}, translate);
    ActiveAgentsWidget.updateSnapshot(props);
    ActiveAgentsWidget.updateTimeline([
      { date: new Date(), props },
      { date: new Date(snapshot.expiresAt), props: buildExpiredProps(snapshot) },
    ]);
    // Mirror the published snapshot onto a present Live Activity so the empty
    // "No work in progress" and stale "Can't update now" copy shows during the
    // terminal window before `endImmediate` ends it. Never start an activity
    // here: start is reserved for the first eligible emit. Record the applied
    // snapshot so a later `end` carries a contentDate that is not older than
    // this update (ActivityKit ignores an end older than the last update).
    // Adopt a leftover instance first: after a process restart the JS handle is
    // null while ActivityKit still holds the activity.
    activity ??= adoptExistingActivity();
    if (activity !== null) {
      lastUpdatedAt = snapshot.updatedAt;
      lastProps = buildGlanceableLiveActivityContentState(snapshot);
      void activity.update(lastProps);
    }
  },

  startOrUpdate(snapshot, ctx) {
    if (activityKitDeniedState || !isEligibleGlanceableWork(snapshot)) {
      return;
    }

    const contentState = buildGlanceableLiveActivityContentState(snapshot);

    if (activity === null) {
      // Adopt the newest existing instance before starting a second one, so a
      // process restart updates the activity it started earlier.
      let adopted = false;
      try {
        const instances = ActiveAgentsLiveActivity.getInstances();
        const newest = instances.at(-1);
        if (newest !== undefined) {
          activity = newest;
          adopted = true;
        }
      } catch (error) {
        if (isActivityKitUnavailable(error)) {
          activityKitDeniedState = true;
          return;
        }
        // A transient getInstances failure leaves activity null; the start
        // below still runs, so a later emit can retry.
      }

      if (activity === null) {
        try {
          activity = ActiveAgentsLiveActivity.start(contentState, OPEN_AGENTS_URL);
        } catch (error) {
          // Only ActivityKit unavailability is permanent; a transient
          // StartLiveActivityException leaves denial unset so a later emit retries.
          if (isActivityKitUnavailable(error)) {
            activityKitDeniedState = true;
          }
          activity = null;
          return;
        }
      }

      lastUpdatedAt = snapshot.updatedAt;
      lastProps = contentState;
      revision = snapshot.revision;
      getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId);
      if (adopted) {
        void activity.update(contentState);
      }
      return;
    }

    // The publisher coalesces and guards revisions, but keep the sink monotonic
    // so a late or replayed emit can never move the surface backwards.
    if (snapshot.revision <= revision) {
      return;
    }
    lastUpdatedAt = snapshot.updatedAt;
    lastProps = contentState;
    void activity.update(contentState);
    revision = snapshot.revision;
  },

  endImmediate() {
    endNow();
  },
};
