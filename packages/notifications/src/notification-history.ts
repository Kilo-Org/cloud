import { type PushData } from './push-data';

/**
 * Notification-settings categories a recorded push can belong to. These are the
 * per-category keys the settings screen toggles, so a history row filters by
 * exactly the category whose switch governs that push.
 */
export const NOTIFICATION_HISTORY_CATEGORIES = [
  'chatMessages',
  'agentAttention',
  'sessionStatus',
  'balanceAlerts',
  'spendAlerts',
  'securityFindings',
] as const;

export type NotificationHistoryCategory = (typeof NOTIFICATION_HISTORY_CATEGORIES)[number];

/**
 * How long a history row stays readable and stored. The worker prune and the
 * query window both read this, so a row never appears in the list after the
 * prune's cutoff nor disappears from it before the retention promise ends.
 */
export const NOTIFICATION_HISTORY_RETENTION_DAYS = 90;

export const NOTIFICATION_HISTORY_RETENTION_MS =
  NOTIFICATION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Rows per page of the history query. */
export const NOTIFICATION_HISTORY_DEFAULT_PAGE_SIZE = 30;

/**
 * Push kinds that become history rows. A kind is recorded only when the push
 * carries something the user can reopen from a list, and every recorded kind
 * has one settings category except briefings, which have none.
 *
 * Every other kind is an OS-only surface (glanceable aggregate, Live Activity,
 * followed-session update, widget data) with no message to read back, so it is
 * never recorded. The switch in `notificationHistoryEntryForPushData` is the
 * authority; this list mirrors it for callers and tests, which assert the two
 * agree over every kind in `pushDataSchema`.
 */
export type RecordedNotificationPushType =
  | 'chat.message'
  | 'cloud_agent_session'
  | 'low_balance'
  | 'spend_alert'
  | 'security_finding'
  | 'security_lifecycle'
  | 'agent_briefing';

export const RECORDED_NOTIFICATION_PUSH_TYPES: readonly RecordedNotificationPushType[] = [
  'chat.message',
  'cloud_agent_session',
  'low_balance',
  'spend_alert',
  'security_finding',
  'security_lifecycle',
  'agent_briefing',
];

/** One history row's content, derived from the push it came from. */
export type NotificationHistoryEntry = {
  pushType: RecordedNotificationPushType;
  /** Settings key the push belongs to; null for briefings, which have none. */
  category: NotificationHistoryCategory | null;
};

/**
 * Resolve the history entry for a push, or `null` when the kind is not recorded.
 *
 * The category must match the preference that gates the dispatch, or a row
 * would sit under a switch that never controlled it:
 * - `cloud_agent_session` is gated per session category: a needs-input raise is
 *   `agentAttention`, a status/ready push is `sessionStatus`, and an omitted
 *   tag defaults to `status` (the rolling-deploy default).
 * - balance, spend and security pushes are gated by their own category.
 */
export function notificationHistoryEntryForPushData(
  data: PushData
): NotificationHistoryEntry | null {
  switch (data.type) {
    case 'chat.message':
      return { pushType: 'chat.message', category: 'chatMessages' };
    case 'cloud_agent_session':
      return {
        pushType: 'cloud_agent_session',
        category: data.category === 'attention' ? 'agentAttention' : 'sessionStatus',
      };
    case 'low_balance':
      return { pushType: 'low_balance', category: 'balanceAlerts' };
    case 'spend_alert':
      return { pushType: 'spend_alert', category: 'spendAlerts' };
    case 'security_finding':
      return { pushType: 'security_finding', category: 'securityFindings' };
    case 'security_lifecycle':
      return { pushType: 'security_lifecycle', category: 'securityFindings' };
    case 'agent_briefing':
      return { pushType: 'agent_briefing', category: null };
    default:
      return null;
  }
}
