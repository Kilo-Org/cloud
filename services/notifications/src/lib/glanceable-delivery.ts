/**
 * Aggregate glanceable snapshot delivery for the Active Agents Live Activity,
 * widgets, and Android ongoing notification. Runs after a cloud-agent session
 * notification send: it fetches the fresh snapshot from the web internal route,
 * then pushes it to the registered iOS activity tokens over APNs and to the
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

export function apnsEventForTokenKind(kind: IosActivityToken['kind']): LiveActivityEvent {
  return kind === 'ios_push_to_start' ? 'start' : 'update';
}

export function toGlanceableContentState(
  snapshot: ActiveAgentsGlanceable
): GlanceableApnsContentState {
  const contentState: GlanceableLiveActivityContentState = {
    status: snapshot.status,
    running: snapshot.running,
    needsInput: snapshot.needsInput,
    reconnecting: snapshot.reconnecting,
    eligibleStartedAt: snapshot.eligibleStartedAt,
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
  ) => Promise<IosActivityToken[]>;
  sendIosLiveActivity: (
    tokens: readonly { token: string; event: LiveActivityEvent }[],
    contentState: GlanceableApnsContentState
  ) => Promise<void>;
  listIosExpoTokens: (userId: string, organizationId: string | null) => Promise<ExpoPushToken[]>;
  listAndroidExpoTokens: (
    userId: string,
    organizationId: string | null
  ) => Promise<ExpoPushToken[]>;
  hasAndroidOngoingToken: (userId: string, organizationId: string | null) => Promise<boolean>;
  sendExpoPush: (messages: ExpoPushMessage[]) => Promise<void>;
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
  if (iosTokens.length > 0) {
    await deps.sendIosLiveActivity(
      iosTokens.map(({ token, kind }) => ({ token, event: apnsEventForTokenKind(kind) })),
      contentState
    );
  }

  // iOS Expo tokens always need the data-only wake: it drives the widget
  // timeline through the background task while the app is not foregrounded.
  const iosExpoTokens = await deps.listIosExpoTokens(params.userId, params.organizationId);
  if (iosExpoTokens.length > 0) {
    await deps.sendExpoPush(buildGlanceableExpoMessages(iosExpoTokens, snapshot));
  }

  if (await deps.hasAndroidOngoingToken(params.userId, params.organizationId)) {
    const expoTokens = await deps.listAndroidExpoTokens(params.userId, params.organizationId);
    if (expoTokens.length > 0) {
      await deps.sendExpoPush(buildGlanceableExpoMessages(expoTokens, snapshot));
    }
  }
}
