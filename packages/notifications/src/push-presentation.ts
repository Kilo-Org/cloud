import { type PushData } from './push-data';
import { translatePush } from './i18n';

/**
 * Android notification channels. Each push is routed to exactly one channel
 * so the OS can group and prioritize it. `importance` maps to
 * `Notifications.AndroidImportance` on the mobile side, and `bypassDnd` to
 * `Notifications.setNotificationChannelAsync`'s `bypassDnd` (the OS still
 * requires the user's own Do Not Disturb access for it to take effect).
 */
export const ANDROID_NOTIFICATION_CHANNELS = [
  { id: 'needs-input', name: 'Needs input', importance: 'high', bypassDnd: true },
  { id: 'agent-progress', name: 'Agent progress', importance: 'default', bypassDnd: false },
  { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default', bypassDnd: false },
  { id: 'balance', name: 'Balance alerts', importance: 'default', bypassDnd: false },
  { id: 'security', name: 'Security findings', importance: 'high', bypassDnd: false },
] as const;

export type AndroidNotificationChannelId = (typeof ANDROID_NOTIFICATION_CHANNELS)[number]['id'];

/**
 * The channel every Android build before the agent-channel split creates for
 * agent pushes. It is not in `ANDROID_NOTIFICATION_CHANNELS`: current builds
 * only create the split channels, and this id exists solely so a server push
 * can still reach a token registered by an older build (see
 * `androidChannelIdForPushDataToAppVersion`). Android 8+ drops a notification
 * addressed to a channel the app never created, so an old install must never
 * be sent `needs-input`/`agent-progress`.
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
 * recorded there has no `needs-input`/`agent-progress` channel and Android 8+
 * would drop the push. Only the build configured here creates both channels, so
 * only that build and later may be addressed with them.
 */
export const AGENT_CHANNEL_SPLIT_APP_VERSION = '1.0.12';

/** Both channel resolvers gate on the same first split-channel release. */
export const ANDROID_AGENT_KIND_CHANNELS_MIN_APP_VERSION = AGENT_CHANNEL_SPLIT_APP_VERSION;

/** The agent channels that only a build at or above the split's release creates. */
const AGENT_KIND_ANDROID_CHANNELS: readonly AndroidNotificationChannelId[] = [
  'needs-input',
  'agent-progress',
];

/**
 * Compare dotted-numeric versions (`1.10.0` > `1.9.9`, missing segments count
 * as zero). A version the server cannot parse sorts below every release, so a
 * client that cannot prove its age never receives a channel id it may not have
 * created.
 */
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

/** A channel a server push may address, including pre-split channel ids. */
export type AndroidPushChannelId =
  | AndroidNotificationChannelId
  | typeof LEGACY_AGENT_ANDROID_CHANNEL_ID
  | 'chat'
  | 'active-agents';

/**
 * Resolve the channel a *server push* addresses for a token registered by
 * `appVersion`. Unlike the channel-only resolver, the payload identifies the
 * legacy channel a pre-split client created. An unversioned token still omits
 * the id because it may predate channel creation entirely.
 */
export function androidChannelIdForPushDataToAppVersion(
  data: PushData,
  appVersion: string | null | undefined
): AndroidPushChannelId | undefined {
  const channelId = androidChannelIdForPushData(data);
  const registeredChannel = androidChannelIdForRegisteredClient(channelId, appVersion);
  if (registeredChannel !== undefined || appVersion == null) {
    return registeredChannel;
  }
  switch (data.type) {
    case 'cloud_agent_session':
      return LEGACY_AGENT_ANDROID_CHANNEL_ID;
    case 'chat.message':
      return 'chat';
    case 'active_agents_glanceable':
      return 'active-agents';
    default:
      return undefined;
  }
}

/**
 * The Android channel a token's client can actually receive, or `undefined`
 * when the client predates channel creation or predates the named agent
 * channels. The caller omits `channelId` in that case; Android then posts to
 * the app's default channel instead of dropping the notification.
 */
export function androidChannelIdForRegisteredClient(
  channelId: AndroidNotificationChannelId,
  appVersion: string | null | undefined
): AndroidNotificationChannelId | undefined {
  if (appVersion == null) {
    return undefined;
  }
  if (!AGENT_KIND_ANDROID_CHANNELS.includes(channelId)) {
    return channelId;
  }
  return isPushAppVersionAtLeast(appVersion, ANDROID_AGENT_KIND_CHANNELS_MIN_APP_VERSION)
    ? channelId
    : undefined;
}

/**
 * The named kinds every agent notification is split into. The user can keep
 * needs-input (breaks through Do Not Disturb) and silence progress (does not).
 * Every presentation decision — Android channel, iOS interruption level —
 * derives from this model so the push route and the local surfaces cannot
 * drift apart.
 */
export const AGENT_NOTIFICATION_KINDS = ['needs-input', 'progress'] as const;

export type AgentNotificationKind = (typeof AGENT_NOTIFICATION_KINDS)[number];

type AgentPushData = Extract<
  PushData,
  { type: 'cloud_agent_session' | 'chat.message' | 'active_agents_glanceable' }
>;

/** True for the push variants that are agent notifications and carry a kind. */
function isAgentPushData(data: PushData): data is AgentPushData {
  return (
    data.type === 'cloud_agent_session' ||
    data.type === 'chat.message' ||
    data.type === 'active_agents_glanceable'
  );
}

/**
 * The single needs-input rule for the counts the glanceable snapshot carries.
 * The push route and the local Android card both read it, so a snapshot with
 * work waiting on the user maps to the same kind in both places.
 */
export function agentNotificationKindForGlanceableSnapshot(snapshot: {
  needsInput: number;
}): AgentNotificationKind {
  return snapshot.needsInput > 0 ? 'needs-input' : 'progress';
}

/** The kind of an agent push. Non-agent pushes have none. */
function agentKindForAgentPush(data: AgentPushData): AgentNotificationKind {
  switch (data.type) {
    case 'cloud_agent_session':
      // The schema default is 'status', applied at the producer's enforcement
      // read site; an omitted category is a status update, not a question.
      return data.category === 'attention' ? 'needs-input' : 'progress';
    case 'chat.message':
      // A reply in the user's conversation is what the user answers.
      return 'needs-input';
    case 'active_agents_glanceable':
      return agentNotificationKindForGlanceableSnapshot(data);
    default: {
      // Exhaustiveness: new agent push variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

/** The named kind of a push, or null when it is not an agent notification. */
export function agentNotificationKindForPushData(data: PushData): AgentNotificationKind | null {
  return isAgentPushData(data) ? agentKindForAgentPush(data) : null;
}

/** The Android channel that carries a kind. */
export function androidChannelIdForAgentKind(
  kind: AgentNotificationKind
): AndroidNotificationChannelId {
  return kind === 'needs-input' ? 'needs-input' : 'agent-progress';
}

/**
 * The kind a posted Android agent channel carries, or null for any other
 * channel. The reverse of `androidChannelIdForAgentKind`: the mobile ongoing
 * card reads the channel the native module last posted to decide whether the
 * card already in the shade is a needs-input one (see
 * `apps/mobile/src/glanceable-android/android-sink.ts`).
 */
export function agentNotificationKindForAndroidChannelId(
  channelId: string | null | undefined
): AgentNotificationKind | null {
  switch (channelId) {
    case 'needs-input':
      return 'needs-input';
    case 'agent-progress':
      return 'progress';
    default:
      return null;
  }
}

/**
 * The iOS interruption level for a push. Needs-input breaks through a Focus /
 * Do Not Disturb; every other push, agent or not, stays active.
 */
export function iosInterruptionLevelForPushData(data: PushData): 'time-sensitive' | 'active' {
  return agentNotificationKindForPushData(data) === 'needs-input' ? 'time-sensitive' : 'active';
}

/**
 * Whether an iOS push must carry `mutable-content` so the app's notification
 * service extension sees it before the system shows it.
 *
 * Only a `progress` agent push can be dropped by the per-Focus filter: the
 * extension is the iOS delivery path where the choice the Focus filter stored
 * is applied while the app is not in the foreground (see
 * `modules/notification-focus-filter/ios/NotificationServiceExtension`). Every
 * other push is delivered directly, without waking the extension.
 *
 * The `active_agents_glanceable` snapshot is data-only — no alert, it exists to
 * wake the widget / Live Activity path — so there is no banner for the
 * extension to drop and it is left out.
 */
export function iosMutableContentForPushData(data: PushData): boolean {
  if (data.type === 'active_agents_glanceable') {
    return false;
  }
  return agentNotificationKindForPushData(data) === 'progress';
}

/** Map a push payload to the Android channel that should carry it. */
export function androidChannelIdForPushData(data: PushData): AndroidNotificationChannelId {
  if (isAgentPushData(data)) {
    return androidChannelIdForAgentKind(agentKindForAgentPush(data));
  }
  switch (data.type) {
    case 'instance-lifecycle':
    case 'scheduled-action':
      return 'kiloclaw';
    case 'low_balance':
      return 'balance';
    case 'security_finding':
    case 'security_lifecycle':
      return 'security';
    default: {
      // Exhaustiveness: the agent variants returned above.
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
