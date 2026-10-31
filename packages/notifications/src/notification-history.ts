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
 * Push kinds that become history rows, keyed by kind, with the settings
 * category that gates each one. A kind is recorded only when the push carries
 * something the user can reopen from a list, and every recorded kind has one
 * settings category except briefings, which have none.
 *
 * Every other kind is an OS-only surface (glanceable aggregate, Live Activity,
 * followed-session update, widget data) with no message to read back, so it is
 * never recorded.
 *
 * This map is the only place a recorded kind is declared: the exported list and
 * the resolver both derive from it, so adding a kind here is the whole change
 * and a kind cannot be listed without a category rule.
 */
const RECORDED_PUSH_HISTORY_RULES = {
  'chat.message': () => 'chatMessages',
  // A needs-input raise is gated by `agentAttention`; a status/ready push by
  // `sessionStatus`, and an omitted tag is a status push (the rolling-deploy
  // default the dispatch gate applies).
  cloud_agent_session: (data: PushData) =>
    data.type === 'cloud_agent_session' && data.category === 'attention'
      ? 'agentAttention'
      : 'sessionStatus',
  low_balance: () => 'balanceAlerts',
  spend_alert: () => 'spendAlerts',
  security_finding: () => 'securityFindings',
  security_lifecycle: () => 'securityFindings',
  // Briefings have no settings category; they appear under All only.
  agent_briefing: () => null,
} satisfies Partial<
  Record<PushData['type'], (data: PushData) => NotificationHistoryCategory | null>
>;

export type RecordedNotificationPushType = keyof typeof RECORDED_PUSH_HISTORY_RULES;

export const RECORDED_NOTIFICATION_PUSH_TYPES = Object.keys(
  RECORDED_PUSH_HISTORY_RULES
) as readonly RecordedNotificationPushType[];

/** One history row's content, derived from the push it came from. */
export type NotificationHistoryEntry = {
  pushType: RecordedNotificationPushType;
  /** Settings key the push belongs to; null for briefings, which have none. */
  category: NotificationHistoryCategory | null;
};

/** True for the push kinds that become a history row. */
function isRecordedNotificationPush(
  type: PushData['type']
): type is RecordedNotificationPushType {
  return Object.hasOwn(RECORDED_PUSH_HISTORY_RULES, type);
}

/**
 * Resolve the history entry for a push, or `null` when the kind is not recorded.
 *
 * The category must match the preference that gates the dispatch, or a row
 * would sit under a switch that never controlled it.
 */
export function notificationHistoryEntryForPushData(
  data: PushData
): NotificationHistoryEntry | null {
  if (!isRecordedNotificationPush(data.type)) return null;
  return {
    pushType: data.type,
    category: RECORDED_PUSH_HISTORY_RULES[data.type](data),
  };
}
