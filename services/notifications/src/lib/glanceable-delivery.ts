/**
 * Aggregate glanceable snapshot delivery for the Active Agents Live Activity,
 * widgets, and Android ongoing notification. Committed metadata and live-session
 * transitions trigger a fresh snapshot fetch from the web internal route,
 * which is then pushed to the registered iOS activity tokens over APNs and to the
 * user's Expo tokens on iOS and Android. Pure orchestrator — all IO is injected
 * via `deps` so tests substitute in-memory fakes.
 */

import { type GlanceableLiveActivityContentState, type PushData } from '@kilocode/notifications';

import type { LiveActivityEvent } from './apns-live-activity';
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

export type IosActivityToken = { token: string; kind: 'ios_activity' | 'ios_push_to_start' };
export type ExpoPushToken = { token: string; locale: string | null };

/**
 * Update eligible activities or end zero-count activities. Never start empty work.
 * A push-to-start token is used only when no activity target remains, avoiding
 * duplicate activities while allowing fresh work after terminal target retirement.
 */
export function apnsSendsForTokens(
  tokens: readonly IosActivityToken[],
  eligible: boolean
): { token: string; event: LiveActivityEvent }[] {
  const activityTokens = tokens.filter(token => token.kind === 'ios_activity');
  if (activityTokens.length > 0) {
    return activityTokens.map(({ token }) => ({ token, event: eligible ? 'update' : 'end' }));
  }
  return eligible
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
    idle: snapshot.idle,
    needsInputSince: snapshot.needsInputSince,
  };
  return {
    name: ACTIVE_AGENTS_LIVE_ACTIVITY_NAME,
    props: JSON.stringify(contentState),
  };
}

export function buildGlanceableExpoMessages(
  tokens: readonly ExpoPushToken[],
  snapshot: ActiveAgentsGlanceable
): ExpoPushMessage[] {
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
        priority: 'default',
        channelId: 'active-agents',
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
    timestampSeconds: number,
    isCurrent?: () => Promise<boolean>,
    beforeEnd?: (token: string) => Promise<boolean>,
    onEndRejected?: (token: string) => Promise<void>
  ) => Promise<void>;
  /** Reserved before reading; do not assign a new timestamp after a delayed send. */
  apnsTimestampSeconds?: number;
  /** Durable generation fence, also checked by adapters after awaits and before outbound sends. */
  isCurrent?: () => Promise<boolean>;
  /** Atomically fence and persist an end intent before the transport sends it. */
  beforeIosEnd?: (token: string) => Promise<boolean>;
  /** Release the current attempt only after an explicit transport rejection. */
  onIosEndRejected?: (token: string) => Promise<void>;
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

  const iosTokens = await deps.listIosActivityTokens(params.userId, params.organizationId);
  if (deps.isCurrent && !(await deps.isCurrent())) return;
  const eligible = snapshot.running + snapshot.needsInput + snapshot.idle > 0;
  const iosSends = apnsSendsForTokens(iosTokens, eligible);
  if (iosSends.length > 0) {
    await deps.sendIosLiveActivity(
      iosSends,
      contentState,
      deps.apnsTimestampSeconds ?? Math.floor(Date.parse(snapshot.updatedAt) / 1000),
      deps.isCurrent,
      deps.beforeIosEnd,
      deps.onIosEndRejected
    );
  }

  // iOS Expo tokens always need the data-only wake: it drives the widget
  // timeline through the background task while the app is not foregrounded.
  const iosExpoTokens = await deps.listIosExpoTokens(params.userId, params.organizationId);
  if (deps.isCurrent && !(await deps.isCurrent())) return;
  if (iosExpoTokens.length > 0) {
    await deps.sendExpoPush(buildGlanceableExpoMessages(iosExpoTokens, snapshot), deps.isCurrent);
  }

  if (await deps.hasAndroidOngoingToken(params.userId, params.organizationId)) {
    const expoTokens = await deps.listAndroidExpoTokens(params.userId, params.organizationId);
    if (deps.isCurrent && !(await deps.isCurrent())) return;
    if (expoTokens.length > 0) {
      await deps.sendExpoPush(buildGlanceableExpoMessages(expoTokens, snapshot), deps.isCurrent);
    }
  }
}
