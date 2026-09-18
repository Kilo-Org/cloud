import { type PushData } from './push-data';
import { translatePush } from './i18n';

/**
 * Android notification channels. Each push is routed to exactly one channel
 * so the OS can group and prioritize it. `importance` maps to
 * `Notifications.AndroidImportance` on the mobile side.
 */
export const ANDROID_NOTIFICATION_CHANNELS = [
  // A needs-input raise is time-sensitive and breaks through on `agent-attention`;
  // ordinary agent progress stays quiet on `agent-progress`. Progress needs its
  // own id: Android never lowers the importance of a channel that already
  // exists, so the `agent` channel created with `high` by earlier installs would
  // keep breaking through if progress still routed to it.
  { id: 'agent-attention', name: 'Agent needs input', importance: 'high' },
  { id: 'agent-progress', name: 'Agent sessions', importance: 'default' },
  { id: 'chat', name: 'Chat messages', importance: 'high' },
  { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default' },
  { id: 'balance', name: 'Balance alerts', importance: 'default' },
  { id: 'security', name: 'Security findings', importance: 'high' },
  { id: 'active-agents', name: 'Active agents', importance: 'default' },
] as const;

export type AndroidNotificationChannelId = (typeof ANDROID_NOTIFICATION_CHANNELS)[number]['id'];

/**
 * The channel id every install created before the split above. It still exists
 * on those installs (created `high`), so it is the only id that can carry an
 * agent push to an app that has not created `agent-attention`/`agent-progress`.
 * Never route a current client to it: this contract's app does not create it,
 * and Android 8+ drops a notification addressed to a channel that does not
 * exist.
 */
export const LEGACY_ANDROID_AGENT_CHANNEL_ID = 'agent';

/**
 * The first mobile version that creates `agent-attention` and `agent-progress`.
 * Both channels land together, so this is the version from
 * `apps/mobile/app.config.ts` when the split shipped. A token registered by an
 * older build carries a non-null `app_version` but has never created either
 * channel, so the split ids must not be sent to it. The gate must stay above
 * every version already released without the split (`1.0.11` was), or those
 * installs clear it and receive channels they never created.
 */
export const ANDROID_AGENT_CHANNELS_MIN_APP_VERSION = '1.0.12';

/** A channel id an Android client may actually have created. */
export type AndroidPushChannelId =
  | AndroidNotificationChannelId
  | typeof LEGACY_ANDROID_AGENT_CHANNEL_ID;

/**
 * Compare dotted numeric version strings (`1.10.0` > `1.9.9`, a missing
 * segment counts as zero). Returns <0, 0, or >0 like `strcmp`. Mirrors the
 * app's `compareAppVersions` so the server gates on the same ordering.
 */
export function compareAppVersions(a: string, b: string): number {
  const left = a.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const right = b.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * True when `version` is at or above `min`. An unknown version never clears the
 * gate: a client that cannot prove it created the split channels keeps the
 * legacy id.
 */
export function isAppVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) {
    return false;
  }
  return compareAppVersions(version, min) >= 0;
}

/**
 * Map a push payload to the Android channel that should carry it on a client
 * registered at `appVersion`. Only the agent split is version-gated: every
 * other channel predates it and is created by every install. A version below
 * the split, or no version at all, falls back to the legacy `agent` channel.
 */
export function androidChannelIdForPushDataAtAppVersion(
  data: PushData,
  appVersion: string | null | undefined
): AndroidPushChannelId {
  const channelId = androidChannelIdForPushData(data);
  if (data.type !== 'cloud_agent_session') {
    return channelId;
  }
  return isAppVersionAtLeast(appVersion, ANDROID_AGENT_CHANNELS_MIN_APP_VERSION)
    ? channelId
    : LEGACY_ANDROID_AGENT_CHANNEL_ID;
}

/** Map a push payload to the Android channel that should carry it. */
export function androidChannelIdForPushData(data: PushData): AndroidNotificationChannelId {
  switch (data.type) {
    case 'cloud_agent_session':
      return data.category === 'attention' ? 'agent-attention' : 'agent-progress';
    case 'chat.message':
      return 'chat';
    case 'instance-lifecycle':
    case 'scheduled-action':
      return 'kiloclaw';
    case 'low_balance':
      return 'balance';
    case 'security_finding':
    case 'security_lifecycle':
      return 'security';
    case 'active_agents_glanceable':
      return 'active-agents';
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

/**
 * Content-free push copy for the `generic` preview mode. Never embeds a
 * session title, message body, org name, amount, or id — the OS lock-screen
 * text must not leak private content.
 */
export function genericPushContentForPushData(
  data: PushData,
  // Old callers omit locale; remove the default when every caller passes a token locale.
  locale: string | null | undefined = 'en'
): { title: string; body: string } {
  switch (data.type) {
    case 'cloud_agent_session':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.cloudAgentSession',
          undefined,
          'Your agent session has an update'
        ),
      };
    case 'chat.message':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.chatMessage',
          undefined,
          'You have a new message'
        ),
      };
    case 'instance-lifecycle':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.instanceLifecycle',
          undefined,
          'Your instance has an update'
        ),
      };
    case 'scheduled-action':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.scheduledAction',
          undefined,
          'A scheduled action has an update'
        ),
      };
    case 'low_balance':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.lowBalance',
          undefined,
          'Your balance needs attention'
        ),
      };
    case 'security_finding':
    case 'security_lifecycle':
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.securityFinding',
          undefined,
          'A security finding needs attention'
        ),
      };
    case 'active_agents_glanceable':
      // Generic, count-free lock-screen banner copy: the ongoing notification
      // never leaks how many agents are running or which sessions they are.
      return {
        title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
        body: translatePush(
          locale,
          'generic.body.activeAgentsGlanceable',
          undefined,
          'Active agents have an update'
        ),
      };
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
