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
 * The iOS interruption level for a push. Needs-input breaks through a Focus /
 * Do Not Disturb; every other push, agent or not, stays active.
 */
export function iosInterruptionLevelForPushData(data: PushData): 'time-sensitive' | 'active' {
  return agentNotificationKindForPushData(data) === 'needs-input' ? 'time-sensitive' : 'active';
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
