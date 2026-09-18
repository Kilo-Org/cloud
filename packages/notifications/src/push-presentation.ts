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
 * The channel every Android build before the agent-channel split creates for
 * agent pushes. It is not in `ANDROID_NOTIFICATION_CHANNELS`: current builds
 * only create the split channels, and this id exists solely so a server push
 * can still reach a token registered by an older build (see
 * `androidChannelIdForPushDataToAppVersion`). Android 8+ drops a notification
 * addressed to a channel the app never created, so an old install must never
 * be sent `agent-attention`/`agent-progress`.
 */
export const LEGACY_AGENT_ANDROID_CHANNEL_ID = 'agent';

/**
 * The first mobile version that creates both split agent channels. `app_version`
 * on a push token is the build that created that device's channels, so a lower
 * version only has `LEGACY_AGENT_ANDROID_CHANNEL_ID`.
 *
 * This must stay the version in `apps/mobile/app.config.ts` — the build this
 * branch ships. It cannot be a version that already reached users without the
 * split: `1.0.11` was released before the split channels existed, so a token
 * recorded there has no `agent-attention`/`agent-progress` channel and Android 8+
 * would drop the push. Only the build configured here creates both channels, so
 * only that build and later may be addressed with them.
 */
export const AGENT_CHANNEL_SPLIT_APP_VERSION = '1.0.12';

/** `a` minus `b` for dotted numeric versions; missing segments count as zero. */
export function comparePushAppVersions(a: string, b: string): number {
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
 * True when `current` is at or above `min`. An unknown version never clears the
 * gate, so a token without a recorded version is treated as an older build.
 */
export function isPushAppVersionAtLeast(current: string | null | undefined, min: string): boolean {
  if (!current) {
    return false;
  }
  return comparePushAppVersions(current, min) >= 0;
}

/** A channel a server push may address: a declared channel or the legacy `agent`. */
export type AndroidPushChannelId =
  | AndroidNotificationChannelId
  | typeof LEGACY_AGENT_ANDROID_CHANNEL_ID;

/**
 * Resolve the channel a *server push* addresses for a token registered by
 * `appVersion`. Every non-agent channel predates the split, so only the agent
 * channels fall back to the legacy id for a build that never created them.
 */
export function androidChannelIdForPushDataToAppVersion(
  data: PushData,
  appVersion: string | null | undefined
): AndroidPushChannelId {
  const channelId = androidChannelIdForPushData(data);
  if (channelId !== 'agent-attention' && channelId !== 'agent-progress') {
    return channelId;
  }
  return isPushAppVersionAtLeast(appVersion, AGENT_CHANNEL_SPLIT_APP_VERSION)
    ? channelId
    : LEGACY_AGENT_ANDROID_CHANNEL_ID;
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
