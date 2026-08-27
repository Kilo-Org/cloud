/**
 * Aggregate glanceable snapshot delivery for the Active Agents Live Activity,
 * widgets, and Android ongoing notification. Runs after a cloud-agent session
 * notification send: it fetches the fresh snapshot from the web internal route,
 * then pushes it to the registered iOS activity tokens over APNs and to the
 * user's Expo tokens on Android. Pure orchestrator — all IO is injected via
 * `deps` so tests substitute in-memory fakes.
 */

import {
  genericPushContentForPushData,
  resolvePushLocale,
  type PushData,
} from '@kilocode/notifications';

import type { LiveActivityEvent } from './apns-live-activity';
import type { ExpoPushMessage } from './expo-push';

export type ActiveAgentsGlanceable = Extract<PushData, { type: 'active_agents_glanceable' }>;
/** The APNs `content-state` is the snapshot without the `type` discriminator and without `accountEpoch`. */
export type GlanceableContentState = Omit<ActiveAgentsGlanceable, 'type'>;

export type IosActivityToken = { token: string; kind: 'ios_activity' | 'ios_push_to_start' };
export type AndroidPushToken = { token: string; locale: string | null };

export function apnsEventForTokenKind(kind: IosActivityToken['kind']): LiveActivityEvent {
  return kind === 'ios_push_to_start' ? 'start' : 'update';
}

export function toGlanceableContentState(snapshot: ActiveAgentsGlanceable): GlanceableContentState {
  const { type: _type, ...contentState } = snapshot;
  return contentState;
}

export function buildAndroidGlanceableMessages(
  tokens: readonly AndroidPushToken[],
  snapshot: ActiveAgentsGlanceable
): ExpoPushMessage[] {
  return tokens.map(({ token, locale }) => {
    const { title, body } = genericPushContentForPushData(snapshot, resolvePushLocale(locale));
    return {
      to: token,
      title,
      body,
      data: snapshot,
      // The aggregate push is a data carrier for the ongoing notification, so
      // it never rings or interrupts: no sound, default (not high) priority.
      sound: null,
      priority: 'default',
      channelId: 'active-agents',
      // Android collapse key = the opaque scope key, so every aggregate update
      // for one user+org collapses into the same ongoing notification.
      tag: snapshot.scopeKey,
    } satisfies ExpoPushMessage;
  });
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
    contentState: GlanceableContentState
  ) => Promise<void>;
  listAndroidExpoTokens: (
    userId: string,
    organizationId: string | null
  ) => Promise<AndroidPushToken[]>;
  hasAndroidOngoingToken: (userId: string, organizationId: string | null) => Promise<boolean>;
  sendAndroidPush: (messages: ExpoPushMessage[]) => Promise<void>;
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

  if (await deps.hasAndroidOngoingToken(params.userId, params.organizationId)) {
    const expoTokens = await deps.listAndroidExpoTokens(params.userId, params.organizationId);
    if (expoTokens.length > 0) {
      await deps.sendAndroidPush(buildAndroidGlanceableMessages(expoTokens, snapshot));
    }
  }
}
