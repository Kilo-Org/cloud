/* eslint-disable max-lines -- one ActivityKit sink: adopt, start, update, and end */
import {
  countGlanceableApprovals,
  countGlanceableSessions,
  GLANCEABLE_STALE_MS,
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
  isStartableGlanceableWork,
  newestGlanceableResult,
  oldestNeedsInputSince,
  soonestScheduledAt,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { aggregateLiveActivityRelevance } from '@kilocode/notifications';

import { i18n } from '@/i18n';
import {
  type FollowableSessionRow,
  type FollowedSessionCounts,
  getFollowedSessionCounts,
  getFollowedSessionIds,
  getSnapshotRows,
} from '@/lib/glanceable/followed-sessions';
import { getHomeWidgetDataForSnapshot } from '@/lib/glanceable/home-widget-data';
import {
  getLastGlanceableSnapshot,
  isGlanceableRestoreSettled,
  isGlanceableRestoreUnavailable,
  restorePersistedGlanceable,
  whenGlanceableRestoresSettle,
} from '@/lib/glanceable/persist';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
} from '@/lib/glanceable/sink-registry';
import {
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import { getWaitingAsk, type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import { ActiveAgentsLiveActivity, OPEN_AGENTS_URL } from './active-agents-live-activity';
import {
  type Activity,
  endExtra,
  endingActivities,
  endOtherVisible,
  readEndingToken,
  scheduleEnd,
  settleEnds,
} from './ending-activities';
import { ActiveAgentsWidget } from './active-agents-widget';
import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  type GlanceableLiveActivityProps,
  toWidgetProps,
  widgetTimelineFrames,
} from './view-props';

/** ActivityKit takes the stale window in seconds. */
const STALE_AFTER_SECONDS = GLANCEABLE_STALE_MS / 1000;

/**
 * The aggregate card's place among this app's cards (spec "Presentation
 * order"): above a running session card while something needs input, below it
 * otherwise, then the newer state change first. The server pushes the same
 * scores.
 */
function aggregateRelevance(snapshot: GlanceableAgentsSnapshot): number {
  return aggregateLiveActivityRelevance(snapshot.needsInput, snapshot.newestResultAt);
}

/**
 * The snapshot the aggregate card counts: the scope's work without the
 * sessions this device follows (spec "Aggregate card coexistence"). Every
 * followed session has its own card, so the aggregate card ends when no other
 * startable work is left, as the server's card does. Only the Live Activity
 * reads this; the Home widget keeps every session.
 *
 * The counts and times come from the tray rows the publisher built the
 * snapshot from, without the followed rows, so the card never shows a
 * followed session's wait or wake time. The rows describe the snapshot only
 * when their counts match it; otherwise (a pushed or a stale snapshot) the
 * followed counts are subtracted and a time stays only while its count does.
 */
function withoutFollowedSessions(snapshot: GlanceableAgentsSnapshot): GlanceableAgentsSnapshot {
  const followed = getFollowedSessionCounts();
  if (followed.running + followed.needsInput + followed.idle + followed.scheduled === 0) {
    return snapshot;
  }
  const remaining = remainingRows(snapshot);
  const card =
    remaining === null ? subtractFollowed(snapshot, followed) : fromRows(snapshot, remaining);
  // While a session is followed, idle work alone does not keep the card.
  return isStartableGlanceableWork(card) ? card : { ...card, idle: 0 };
}

/** The snapshot's own rows without the followed sessions, or null when unknown. */
function remainingRows(snapshot: GlanceableAgentsSnapshot): FollowableSessionRow[] | null {
  const rows = getSnapshotRows(snapshot.scopeKey);
  if (rows === null) {
    return null;
  }
  const counts = countGlanceableSessions(rows);
  const describes =
    counts.running === snapshot.running &&
    counts.needsInput === snapshot.needsInput &&
    counts.idle === snapshot.idle &&
    counts.scheduled === snapshot.scheduled;
  if (!describes) {
    return null;
  }
  const followedIds = getFollowedSessionIds();
  return rows.filter(row => row.id === undefined || !followedIds.has(row.id));
}

function fromRows(
  snapshot: GlanceableAgentsSnapshot,
  rows: readonly FollowableSessionRow[]
): GlanceableAgentsSnapshot {
  const newest = newestGlanceableResult(rows);
  return {
    ...snapshot,
    ...countGlanceableSessions(rows),
    needsApproval: countGlanceableApprovals(rows),
    needsInputSince: oldestNeedsInputSince(rows),
    scheduledAt: soonestScheduledAt(rows),
    newestResultKind: newest?.kind ?? null,
    newestResultAt: newest?.at ?? null,
  };
}

function subtractFollowed(
  snapshot: GlanceableAgentsSnapshot,
  followed: FollowedSessionCounts
): GlanceableAgentsSnapshot {
  const needsInput = Math.max(0, snapshot.needsInput - followed.needsInput);
  const scheduled = Math.max(0, snapshot.scheduled - followed.scheduled);
  return {
    ...snapshot,
    running: Math.max(0, snapshot.running - followed.running),
    needsInput,
    needsApproval: Math.max(0, (snapshot.needsApproval ?? 0) - followed.needsApproval),
    idle: Math.max(0, snapshot.idle - followed.idle),
    scheduled,
    needsInputSince: needsInput === 0 ? null : snapshot.needsInputSince,
    scheduledAt: scheduled === 0 ? null : snapshot.scheduledAt,
  };
}

let activityKitDeniedState = false;
let activity: Activity | null = null;
let revision = 0;
/** In-flight native `update`; `end` awaits it so its contentDate is never older. */
let inFlightUpdate: Promise<void> | null = null;
let lastProps: GlanceableLiveActivityProps | null = null;

function translate(key: string): string {
  return i18n.t(key);
}

/**
 * True while the recorded ask is one Approve can answer: a cloud-agent
 * permission ask whose displayed request's captured id is present — without
 * the capture the press could not prove what it would answer. The count this
 * content state carries includes questions and retried asks, which
 * `runGlanceableApprove` resolves to `none`, so the layout needs this fact to
 * avoid offering a control that cannot act. The read is synchronous and the
 * publisher records the ask before it emits, so the flag matches the counts in
 * the same state.
 */
function isApprovableAskRecorded(): boolean {
  const ask = getWaitingAsk();
  return ask?.status === 'permission' && ask.isCloudAgent && ask.permissionId != null;
}

/**
 * The one-line notice the next Live Activity update carries: the in-app press
 * sets it when Approve fails retryably. It never outlives its ask — a changed
 * ask or a zero needs-input count clears it — so a failure message cannot
 * describe a new session. Mirrors the Android sink's action notice.
 */
let actionNotice: string | null = null;
let noticeAskKey: string | null = null;

/** The recorded ask identity the notice describes; '' means "no ask". */
function askKey(ask: WaitingAsk | null): string {
  return ask === null ? '' : `${ask.kiloSessionId}|${ask.status}`;
}

/** Set (or clear) the notice for the next Live Activity update. */
export function setGlanceableActionNotice(notice: string | null): void {
  actionNotice = notice;
  noticeAskKey = notice === null ? null : askKey(getWaitingAsk());
}

/** Drop the notice once nothing needs input or the recorded ask has changed. */
function pruneActionNotice(snapshot: GlanceableAgentsSnapshot): void {
  if (
    actionNotice !== null &&
    (snapshot.needsInput === 0 || askKey(getWaitingAsk()) !== noticeAskKey)
  ) {
    actionNotice = null;
    noticeAskKey = null;
  }
}

/**
 * Whether an Approve pressed on the card is in flight. The card swaps Approve
 * for a muted Approving… pill until the press resolves; the interaction clears
 * it on every outcome, so it can never stick.
 */
let approving = false;

/** Mark (or clear) the in-flight Approve the next Live Activity update draws. */
export function setGlanceableActionApproving(value: boolean): void {
  approving = value;
}

/**
 * The content-state one update carries: the counts, the Approve gate, and the
 * pending notice when there is one. Every Live Activity update goes through
 * this, so the notice cannot be dropped by one path and kept by another.
 */
function liveActivityContentState(snapshot: GlanceableAgentsSnapshot): GlanceableLiveActivityProps {
  pruneActionNotice(snapshot);
  const contentState = buildGlanceableLiveActivityContentState(
    snapshot,
    isApprovableAskRecorded(),
    actionNotice ?? undefined
  );
  return approving ? { ...contentState, approving: true } : contentState;
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
  contentState: GlanceableLiveActivityProps;
  snapshot: GlanceableAgentsSnapshot;
  ctx: GlanceableSinkContext;
} | null = null;
let pendingStartAt = 0;

/** Raise the card. Shared by the immediate start and the one deferred behind a dismissal. */
function startCard(
  contentState: GlanceableLiveActivityProps,
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext
): void {
  try {
    // Adopt a card that appeared while we waited. A second start stacks Lock
    // Screen cards that Activity.activities cannot see after process death.
    if (!refreshActivity()) {
      return;
    }
    if (activity !== null) {
      lastProps = contentState;
      revision = snapshot.revision;
      getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId, activity);
      inFlightUpdate = activity.update(
        contentState,
        STALE_AFTER_SECONDS,
        aggregateRelevance(snapshot)
      );
      return;
    }
    const remaining = ActiveAgentsLiveActivity.getInstances(true).filter(
      instance => instance.getInfo().state !== 'dismissed'
    );
    if (remaining.length > 0) {
      return;
    }
    // The first start raises iOS's "Allow Live Activities?" prompt. Wait for the
    // user's notification opt-in; the grant replays eligible work (see register).
    if (!getNotificationPermissionGranted()) {
      return;
    }
    const started = ActiveAgentsLiveActivity.start(
      contentState,
      OPEN_AGENTS_URL,
      STALE_AFTER_SECONDS,
      aggregateRelevance(snapshot)
    );
    activity = started;
    inFlightUpdate = null;
    lastProps = contentState;
    revision = snapshot.revision;
    getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId, started);
    endOtherVisible(started.getInfo().id, ActiveAgentsLiveActivity.getInstances(true));
  } catch (error) {
    // Only ActivityKit unavailability is permanent; transient starts retry later.
    if (isActivityKitUnavailable(error)) {
      activityKitDeniedState = true;
    }
  }
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
    // Include ended-but-visible cards so a later start cannot stack beside them.
    const visible = ActiveAgentsLiveActivity.getInstances(true).filter(instance => {
      const info = instance.getInfo();
      return info.state !== 'dismissed' && !endingActivities.has(info.id);
    });
    const live = visible.filter(instance => {
      const state = instance.getInfo().state;
      return state === 'active' || state === 'stale';
    });
    activity ??= live.at(-1) ?? null;
    // Exactly one card may ever be on screen. Retire every other instance here.
    const keptId = activity?.getInfo().id;
    for (const instance of visible) {
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
  props: GlanceableLiveActivityProps | null = lastProps,
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

/**
 * Adopt a card this process did not start and hand its update token to the
 * server. A push-to-start raises the card with no JavaScript running, so
 * nothing has read the native instance yet and the server has no way to update
 * or end it. The native read also retires every instance except the adopted
 * one, so duplicates an earlier process left behind go with it.
 */
export function adoptNativeActivity(
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext
): void {
  if (!getLiveActivityEnabled() || activityKitDeniedState || !refreshActivity()) {
    return;
  }
  if (activity !== null) {
    getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId, activity);
  }
}

/**
 * True while the persisted snapshot can still own a card: present, not a
 * terminal blank, and not past its expiry. An absent, signed-out, privacy, or
 * expired snapshot owns nothing — those are the states a card outlives its
 * owner in.
 *
 * `expired` is checked by name, not only by timestamp:
 * `GlanceablePublisher.applyExpiry()` stamps the lapsed snapshot with a renewed
 * `expiresAt` eight hours out, so `now < expiresAt` alone would read an expired
 * snapshot as an owner for the rest of that window.
 *
 * Counts are deliberately not part of this: an empty snapshot may cover a card
 * a push-to-start raised for a session this process has not seen yet, and
 * ending that card would tear down a surface the server already holds a token
 * for. The publisher retires it moments later if the work really is gone, so
 * keeping it never leaves a stray behind.
 */
function snapshotOwnsSurface(snapshot: GlanceableAgentsSnapshot | null, now: number): boolean {
  return (
    snapshot !== null &&
    snapshot.status !== 'signed_out' &&
    snapshot.status !== 'privacy' &&
    snapshot.status !== 'expired' &&
    now < Date.parse(snapshot.expiresAt)
  );
}

/**
 * End every native card this launch cannot own, so at most one survives.
 *
 * The start path cannot hold the one-card invariant by itself: a card outlives
 * the process that raised it. A session that ends while the app is suspended,
 * an app replaced by a new build, or a killed process leaves a card that no
 * `startOrUpdate` or `publish` of the next launch will ever look at, and
 * ActivityKit keeps drawing it at the counts it held when it started. Native
 * discovery (`getInstances(true)`) is the only source of truth for those, and
 * nothing read it at launch or on foreground.
 *
 * Runs after the persisted snapshot is restored on launch (see
 * `adoptPushStartedActivity`) and on every foreground (see `register.ts`).
 * When no snapshot can own a surface — or when the in-app switch is off —
 * every instance is ended at once. Otherwise the persisted work may own one
 * card this process has not adopted yet, so the normal reconciliation adopts it
 * and ends every other instance immediately.
 *
 * A null snapshot is only proof that nothing owns the surface when the restore
 * actually read the mirror: if that read failed, or has not finished yet,
 * native discovery still collapses duplicates to one card, but that card is
 * kept rather than every instance being ended, so a push-to-start this process
 * woke to adopt survives a locked keychain or a launch whose read is still in
 * flight.
 */
export function sweepStrayActivities(): void {
  if (activityKitDeniedState) {
    return;
  }
  if (!getLiveActivityEnabled()) {
    // `endNow` reads native truth itself and cleans each instance's token, so a
    // card this process never held is retired as thoroughly as its own.
    void endNow();
    return;
  }
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null && !isGlanceableRestoreSettled()) {
    // The read has not finished yet, so a null snapshot means "unknown", not
    // "nothing can own the surface". This runs at import in the headless push
    // process, and on the foreground edge before the launch restore settles,
    // where ending every instance would tear down the card a push-to-start just
    // raised before this process can adopt it. Reconciliation still ends every
    // instance but the one native discovery keeps, so the surface never holds
    // more than one card.
    //
    // The deferral must not drop the sweep: the read this sweep waited for is
    // the only thing that will settle it, and without a rerun an unowned card
    // would stay on the Lock Screen until the next foreground or publisher
    // update. Wait for the last read to land and sweep again.
    void (async () => {
      await whenGlanceableRestoresSettle();
      sweepStrayActivities();
    })();
    refreshActivity();
    return;
  }
  if (snapshot === null && isGlanceableRestoreUnavailable()) {
    // The persisted owner could not be read, so a null snapshot means
    // "unknown", not "nothing can own the surface": the mirror may still name a
    // card owner and this process cannot tell. Reconciliation ends every
    // instance but the one native discovery keeps, and a later foreground or
    // publisher update sweeps again.
    refreshActivity();
    return;
  }
  if (!snapshotOwnsSurface(snapshot, Date.now())) {
    // `endNow` reads native truth itself and cleans each instance's token, so a
    // card this process never held is retired as thoroughly as its own.
    void endNow();
    return;
  }
  refreshActivity();
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
  actionNotice = null;
  noticeAskKey = null;
  approving = false;
  lastSinkContext = null;
}

/**
 * The context of the last tray update, kept for the follow-change republish.
 * A follow change carries no tray update of its own, so the republish uses the
 * one the last publish ran under to register the card's token.
 */
let lastSinkContext: GlanceableSinkContext | null = null;

/**
 * Re-render the aggregate card after a follow or an unfollow, from the last
 * snapshot the publisher wrote.
 *
 * An unfollow makes the reduced card startable again on the spot: the card
 * ended while the last session was followed, and no tray update follows an
 * unfollow that changes nothing else, so the card has to come back here.
 */
export function republishAggregateCard(): void {
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null) {
    return;
  }
  iosSink.publish(snapshot, lastSinkContext ?? undefined);
}

export const iosSink: GlanceableSink = {
  async waitForNativeTerminal() {
    await Promise.all(
      [...endingActivities.values()].map((ending): Promise<void> | null => ending.pending)
    );
    // A replacement card deferred behind a dismissal is part of that terminal work.
    await pendingStart;
  },

  /**
   * Re-render the aggregate card from a snapshot the publisher already wrote.
   *
   * `ctx` is the context of the last tray update. It is present only when the
   * caller may raise a card: the follow subscription passes it, because a
   * follow change can make work startable again on the spot — the card ended
   * while the last session was followed, and no tray update follows an
   * unfollow that changes nothing else. A background press omits it, because a
   * press must never raise a new card.
   */
  publish(snapshot, ctx) {
    const homeData = getHomeWidgetDataForSnapshot(snapshot);
    const props = toWidgetProps(buildGlanceableViewProps(snapshot, {}, translate, homeData));
    ActiveAgentsWidget.updateSnapshot(props);
    // updateSnapshot leaves a single frame behind, so the shared builder adds
    // the delayed and expiry frames every timeline writer owes WidgetKit (see
    // `widgetTimelineFrames`). Null means a terminal blank, whose copy needs no
    // further frame.
    const frames = widgetTimelineFrames(snapshot, props, translate, homeData);
    if (frames !== null) {
      ActiveAgentsWidget.updateTimeline(frames);
    }
    // The Live Activity counts only the sessions this device does not follow.
    const card = withoutFollowedSessions(snapshot);
    const contentState = liveActivityContentState(card);
    if (!isEligibleGlanceableWork(card)) {
      // ActivityKit owns removal after this call, even if JavaScript stops.
      // The after-date retains Lock Screen content, not the Dynamic Island.
      const immediate = snapshot.status === 'signed_out' || snapshot.status === 'privacy';
      // `reachEnded`: work can go empty while an idle card is already counting
      // down its 10 minute window. That card is still on screen and still shows
      // the idle counts, so the terminal window has to reach it.
      void endNow(immediate ? null : GLANCEABLE_TERMINAL_MS, contentState, true);
      return;
    }
    // Recheck cached native work and preserve update/end ordering.
    if (refreshActivity() && activity !== null) {
      lastProps = contentState;
      inFlightUpdate = activity.update(lastProps, STALE_AFTER_SECONDS, aggregateRelevance(card));
      return;
    }
    // No live card. A follow change can make the reduced card startable again
    // with no tray update behind it, so raise the card here when the caller
    // carries a context; `startOrUpdate` owns the replacement of a card that is
    // still waiting out its dismissal.
    if (ctx !== undefined && isStartableGlanceableWork(card)) {
      iosSink.startOrUpdate(snapshot, ctx);
    }
  },

  startOrUpdate(rawSnapshot, ctx) {
    lastSinkContext = ctx;
    // The Live Activity counts only the sessions this device does not follow.
    const snapshot = withoutFollowedSessions(rawSnapshot);
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

    // The content state is built only where it is applied: building it prunes
    // the notice, and a snapshot this call discards (an older revision, or one
    // that cannot start) must not clear the line a live card carries.

    if (pendingStart !== null) {
      // A start is already waiting on a dismissal. There is no card to update
      // yet, and raising a second one is the duplicate this sink exists to stop.
      // Hand the waiting start the newer counts so it does not open stale.
      if (isStartableGlanceableWork(snapshot) && snapshot.revision >= pendingStartAt) {
        pendingStartInput = { contentState: liveActivityContentState(snapshot), snapshot, ctx };
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
      const contentState = liveActivityContentState(snapshot);
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
          try {
            startCard(input.contentState, input.snapshot, input.ctx);
          } finally {
            pendingStart = null;
            pendingStartInput = null;
            pendingStartAt = 0;
          }
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
    const contentState = liveActivityContentState(snapshot);
    lastProps = contentState;
    inFlightUpdate = activity.update(
      contentState,
      STALE_AFTER_SECONDS,
      aggregateRelevance(snapshot)
    );
    revision = snapshot.revision;
  },

  endImmediate() {
    void endNow();
  },
};

/**
 * Re-render the surface the app last published, so a press that cannot reach
 * the backend still shows its pending notice. The snapshot comes from the
 * persisted mirror — a background press may have launched this process with no
 * in-memory state — and it already carries the counts the card shows, so the
 * update adds only the failure line. Reusing `publish` keeps the one render
 * path: the adoption of a card this process did not start, the notice prune,
 * and the content-state build.
 */
export async function renderStoredSnapshotWithNotice(): Promise<void> {
  await restorePersistedGlanceable();
  const snapshot = getLastGlanceableSnapshot();
  if (snapshot === null) {
    return;
  }
  iosSink.publish(snapshot);
  // Keep the background press alive until ActivityKit has applied its notice.
  await inFlightUpdate;
}
