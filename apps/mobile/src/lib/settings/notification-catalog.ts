import {
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategoryKey,
} from '@/lib/hooks/agent-push-preference';

import { notificationBooleanSetting } from './bindings';
import { type AppSettingEntry } from './types';

/**
 * The per-category notification switches. They are server-owned and per-user:
 * the read comes from the `getNotificationPreferences` query cache and the write
 * goes through the tRPC mutation the Notifications screen itself uses, so an
 * agent's change shows up on that screen.
 */
const NOTIFICATION_DESCRIPTIONS = {
  chatMessages: 'Notify about new chat messages.',
  agentAttention: 'Notify when an agent needs your attention.',
  agentUpdates: 'Notify about agent progress updates.',
  sessionStatus: 'Notify when a session starts or finishes.',
  kiloclawActivity: 'Notify about KiloClaw activity.',
  balanceAlerts: 'Notify about balance alerts.',
  securityFindings: 'Notify about security findings.',
} satisfies Record<NotificationCategoryKey, string>;

export const notificationToggleEntries: readonly AppSettingEntry[] = NOTIFICATION_CATEGORY_KEYS.map(
  key => ({
    name: `notifications.${key}`,
    description: NOTIFICATION_DESCRIPTIONS[key],
    kind: 'boolean',
    bind: () => notificationBooleanSetting(`notifications.${key}`, key),
  })
);
