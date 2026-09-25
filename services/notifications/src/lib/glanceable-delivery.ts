/**
 * Aggregate glanceable snapshot delivery for the Active Agents Live Activity,
 * widgets, and Android ongoing notification. Committed metadata and live-session
 * transitions trigger a fresh snapshot fetch from the web internal route,
 * which is then pushed to the registered iOS activity tokens over APNs and to the
 * user's Expo tokens on iOS and Android. Pure orchestrator — all IO is injected
 * via `deps` so tests substitute in-memory fakes.
 */

import {
  isEligibleGlanceableWork,
  isStartableGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  type GlanceableLiveActivityContentState,
  type PushData,
  agentNotificationKindForGlanceableSnapshot,
  androidChannelIdForAgentKind,
  translatePush,
} from '@kilocode/notifications';

import type { LiveActivityAlert, LiveActivityEvent } from './apns-live-activity';
import type { ExpoPushMessage } from './expo-push';

export type ActiveAgentsGlanceable = Extract<PushData, { type: 'active_agents_glanceable' }>;

/** Matches the first argument to `createLiveActivity` in the widget extension. */
const ACTIVE_AGENTS_LIVE_ACTIVITY_NAME = 'ActiveAgentsLiveActivity';

/**
 * The APNs Live Activity `content-state`. expo-widgets wraps the renderable
 * props in a JSON string under `props` and routes on `name`, so iOS decodes
 * `{ name, props }` into the widget extension's `LiveActivityAttributes`.
 */
export type GlanceableApnsContentState = {
  name: string;
  props: string;
};

export type IosActivityToken = {
  token: string;
  kind: 'ios_activity' | 'ios_push_to_start';
  /**
   * True when a newer registration replaced this row. A superseded row is not
   * the live target, so it gets `end` and is retired once that end is confirmed.
   * Optional so literals written before the singleton rule keep compiling.
   */
  superseded?: boolean;
};
export type ExpoPushToken = { token: string; locale: string | null };

/**
 * Update the single live activity target or end zero-count activities. Never
 * start empty work. A push-to-start token is used only when no activity target
 * remains, avoiding duplicate activities while allowing fresh work after
 * terminal target retirement.
 *
 * `tokens` arrives newest-first (`updated_at DESC, id DESC`), so the first
 * `ios_activity` row that is not superseded is the one live card target. Every
 * other activity row is an abandoned card: it gets `end` and its row is retired
 * once that end is confirmed, so two rows can never leave two stacked cards.
 *
 * `startable` is the narrower rule the iOS sink starts on: an agent working,
 * waiting on the user, or scheduled to wake. Idle work keeps a card alive but
 * must never raise one, or a push-to-start resurrects the card the sink just
 * retired for idleness.
 */
export function apnsSendsForTokens(
  tokens: readonly IosActivityToken[],
  eligible: boolean,
  startable: boolean
): { token: string; event: LiveActivityEvent }[] {
  const activityTokens = tokens.filter(token => token.kind === 'ios_activity');
  if (activityTokens.length > 0) {
    // The first non-superseded row is the live target; `-1` (every row
    // superseded) ends them all and lets the next pass raise fresh work.
    const survivor = activityTokens.findIndex(token => token.superseded !== true);
    return activityTokens.map(({ token }, index) => ({
      token,
      event: index === survivor && eligible ? 'update' : 'end',
    }));
  }
  return startable
    ? tokens
        .filter(token => token.kind === 'ios_push_to_start')
        .map(({ token }) => ({ token, event: 'start' }))
    : [];
}

export function toGlanceableContentState(
  snapshot: ActiveAgentsGlanceable
): GlanceableApnsContentState {
  const contentState: GlanceableLiveActivityContentState = {
    status: snapshot.status,
    running: snapshot.running,
    needsInput: snapshot.needsInput,
    needsApproval: snapshot.needsApproval ?? 0,
    idle: snapshot.idle,
    needsInputSince: snapshot.needsInputSince,
    scheduled: snapshot.scheduled,
    scheduledAt: snapshot.scheduledAt,
  };
  return {
    name: ACTIVE_AGENTS_LIVE_ACTIVITY_NAME,
    props: JSON.stringify(contentState),
  };
}

export function buildGlanceableExpoMessages(
  tokens: readonly ExpoPushToken[],
  snapshot: ActiveAgentsGlanceable,
  priority: 'default' | 'high'
): ExpoPushMessage[] {
  const kind = agentNotificationKindForGlanceableSnapshot(snapshot);
  return tokens.map(
    ({ token }) =>
      ({
        to: token,
        data: snapshot,
        // Data-only wake: `_contentAvailable` makes the OS deliver the message to
        // the background task while the app is backgrounded/killed, and omitting
        // title/body keeps it from becoming a visible FCM notification that skips
        // the task. The ongoing notification and widget content come from the local
        // `applyGlanceablePushData` path, so the push never rings or interrupts.
        _contentAvailable: true,
        sound: null,
        // FCM defers normal-priority data messages while Android is
        // backgrounded/Doze, so the Android wake must be `high` to reach the
        // ongoing notification and widget without waiting for the app to open.
        // iOS stays `default`: APNs background `content-available` pushes use
        // priority 5, and Live Activity freshness rides the direct APNs path.
        priority,
        // The wake names the kind's channel because the ongoing card is posted
        // locally on that same channel; the legacy `active-agents` id is deleted
        // on startup and no client creates it, so posting to it would be dropped.
        channelId: androidChannelIdForAgentKind(kind),
        // Android collapse key = the opaque scope key, so every aggregate update
        // for one user+org collapses into the same ongoing notification.
        tag: snapshot.scopeKey,
      }) satisfies ExpoPushMessage
  );
}

type IosActivityRegistration = IosActivityToken & { id: string; updated_at: string };

export type GlanceableDeliveryDeps = {
  /**
   * Build the fresh snapshot via the web internal route. `null` means the
   * snapshot could not be built (route failure, missing config, invalid
   * payload) and the caller must skip delivery.
   */
  buildSnapshot: (
    userId: string,
    organizationId: string | null
  ) => Promise<ActiveAgentsGlanceable | null>;
  listIosActivityTokens: (
    userId: string,
    organizationId: string | null
  ) => Promise<IosActivityRegistration[]>;
  sendIosLiveActivity: (
    tokens: readonly { token: string; event: LiveActivityEvent }[],
    contentState: GlanceableApnsContentState,
    startAlert: LiveActivityAlert,
    timestampSeconds: number,
    isCurrent?: () => Promise<boolean>,
    beforeEnd?: (token: string) => Promise<boolean>,
    onEndRejected?: (token: string) => Promise<void>,
    onStarted?: (token: string) => Promise<void>
  ) => Promise<void>;
  /** Reserved before reading; do not assign a new timestamp after a delayed send. */
  apnsTimestampSeconds?: number;
  /** Durable generation fence, also checked by adapters after awaits and before outbound sends. */
  isCurrent?: () => Promise<boolean>;
  /** Atomically fence and persist an end intent before the transport sends it. */
  beforeIosEnd?: (token: string) => Promise<boolean>;
  /** Release the current attempt only after an explicit transport rejection. */
  onIosEndRejected?: (token: string) => Promise<void>;
  /** Record an accepted push-to-start so the same token cannot raise a second card. */
  onIosStarted?: (token: string) => Promise<void>;
  listIosExpoTokens: (userId: string, organizationId: string | null) => Promise<ExpoPushToken[]>;
  listAndroidExpoTokens: (
    userId: string,
    organizationId: string | null
  ) => Promise<ExpoPushToken[]>;
  hasAndroidOngoingToken: (userId: string, organizationId: string | null) => Promise<boolean>;
  sendExpoPush: (messages: ExpoPushMessage[], isCurrent?: () => Promise<boolean>) => Promise<void>;
};

export async function deliverGlanceableSnapshot(
  params: { userId: string; organizationId: string | null },
  deps: GlanceableDeliveryDeps
): Promise<void> {
  const snapshot = await deps.buildSnapshot(params.userId, params.organizationId);
  if (snapshot === null) {
    return;
  }
  const contentState = toGlanceableContentState(snapshot);

  // Read the iOS Expo rows first: they carry the only per-user locale on this
  // path, and APNs requires a localized alert on a push-to-start. The
  // data-only wake below reuses the same rows, so this costs no extra query.
  const iosExpoTokens = await deps.listIosExpoTokens(params.userId, params.organizationId);
  const locale = iosExpoTokens.find(row => row.locale !== null)?.locale ?? null;

  const iosTokens = await deps.listIosActivityTokens(params.userId, params.organizationId);
  if (deps.isCurrent && !(await deps.isCurrent())) return;
  const eligible = isEligibleGlanceableWork(snapshot);
  const iosSends = apnsSendsForTokens(iosTokens, eligible, isStartableGlanceableWork(snapshot));
  if (iosSends.length > 0) {
    await deps.sendIosLiveActivity(
      iosSends,
      contentState,
      {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.activeAgentsGlanceable',
          undefined,
          'Active agents have an update'
        ),
      },
      deps.apnsTimestampSeconds ?? Math.floor(Date.parse(snapshot.updatedAt) / 1000),
      deps.isCurrent,
      deps.beforeIosEnd,
      deps.onIosEndRejected,
      deps.onIosStarted
    );
  }

  // iOS Expo tokens always need the data-only wake: it drives the widget
  // timeline through the background task while the app is not foregrounded.
  if (deps.isCurrent && !(await deps.isCurrent())) return;
  if (iosExpoTokens.length > 0) {
    await deps.sendExpoPush(
      buildGlanceableExpoMessages(iosExpoTokens, snapshot, 'default'),
      deps.isCurrent
    );
  }

  if (await deps.hasAndroidOngoingToken(params.userId, params.organizationId)) {
    const expoTokens = await deps.listAndroidExpoTokens(params.userId, params.organizationId);
    if (deps.isCurrent && !(await deps.isCurrent())) return;
    if (expoTokens.length > 0) {
      await deps.sendExpoPush(
        buildGlanceableExpoMessages(expoTokens, snapshot, 'high'),
        deps.isCurrent
      );
    }
  }
}
