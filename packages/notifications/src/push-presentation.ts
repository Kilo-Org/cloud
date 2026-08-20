import { type PushData } from './push-data';

/**
 * Android notification channels. Each push is routed to exactly one channel
 * so the OS can group and prioritize it. `importance` maps to
 * `Notifications.AndroidImportance` on the mobile side.
 */
export const ANDROID_NOTIFICATION_CHANNELS = [
  { id: 'agent', name: 'Agent sessions', importance: 'high' },
  { id: 'chat', name: 'Chat messages', importance: 'high' },
  { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default' },
  { id: 'balance', name: 'Balance alerts', importance: 'default' },
  { id: 'security', name: 'Security findings', importance: 'high' },
] as const;

export type AndroidNotificationChannelId = (typeof ANDROID_NOTIFICATION_CHANNELS)[number]['id'];

/** Map a push payload to the Android channel that should carry it. */
export function androidChannelIdForPushData(data: PushData): AndroidNotificationChannelId {
  switch (data.type) {
    case 'cloud_agent_session':
      return 'agent';
    case 'chat.message':
      return 'chat';
    case 'instance-lifecycle':
    case 'scheduled-action':
      return 'kiloclaw';
    case 'low_balance':
      return 'balance';
    case 'security_finding':
      return 'security';
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
export function genericPushContentForPushData(data: PushData): { title: string; body: string } {
  switch (data.type) {
    case 'cloud_agent_session':
      return { title: 'Kilo Code', body: 'Your agent session has an update' };
    case 'chat.message':
      return { title: 'Kilo Code', body: 'You have a new message' };
    case 'instance-lifecycle':
      return { title: 'Kilo Code', body: 'Your instance has an update' };
    case 'scheduled-action':
      return { title: 'Kilo Code', body: 'A scheduled action has an update' };
    case 'low_balance':
      return { title: 'Kilo Code', body: 'Your balance needs attention' };
    case 'security_finding':
      return { title: 'Kilo Code', body: 'A security finding needs attention' };
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
