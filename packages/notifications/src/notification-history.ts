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

/** Marks a push kind that never becomes a history row. */
const NOT_RECORDED = Symbol('notificationHistory.notRecorded');

/** Resolve the settings category that gates one push kind. */
type PushHistoryRule = (data: PushData) => NotificationHistoryCategory | null;

/** A rule for a recorded kind, or the sentinel for a kind that is not recorded. */
type PushHistoryDecision = PushHistoryRule | typeof NOT_RECORDED;

/** One decision per push kind, keyed by kind. */
type PushHistoryDecisions = Record<PushData['type'], PushHistoryDecision>;

/**
 * One history decision per push kind. A kind is recorded only when the push
 * carries something the user can reopen from a list, and every recorded kind
 * has one settings category except briefings, which have none.
 *
 * Every other kind is an OS-only surface (glanceable aggregate, Live Activity,
 * followed-session update, widget data) with no message to read back, so it
 * carries the `NOT_RECORDED` decision.
 *
 * The table is total over `PushData['type']`, so a new variant fails typecheck
 * here until it has a history decision, as `GENERIC_BODY_LEAF_BY_TYPE` in
 * `push-copy.ts` does for the generic preview body.
 *
 * This map is the only place a decision is declared: the exported list and the
 * resolver both derive from it, so adding a kind here is the whole change.
 */
const PUSH_HISTORY_DECISIONS = {
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
  'instance-lifecycle': NOT_RECORDED,
  'scheduled-action': NOT_RECORDED,
  active_agents_glanceable: NOT_RECORDED,
  session_live_update: NOT_RECORDED,
} satisfies PushHistoryDecisions;

/** The kind when its decision is a rule, never otherwise. */
type RecordedPushKind<Kind extends PushData['type']> =
  (typeof PUSH_HISTORY_DECISIONS)[Kind] extends typeof NOT_RECORDED ? never : Kind;

/** The kinds whose decision is a rule: exactly the kinds that become a row. */
export type RecordedNotificationPushType = {
  [Kind in PushData['type']]: RecordedPushKind<Kind>;
}[PushData['type']];

/**
 * True for the push kinds that become a history row.
 *
 * The map is total over `PushData['type']`, but a payload reaches the worker
 * unparsed, so a kind outside the union must answer "not recorded" instead of
 * falling through to a rule call that does not exist.
 */
function isRecordedNotificationPush(type: PushData['type']): type is RecordedNotificationPushType {
  return typeof PUSH_HISTORY_DECISIONS[type] === 'function';
}

export const RECORDED_NOTIFICATION_PUSH_TYPES: readonly RecordedNotificationPushType[] =
  // `Object.keys` is typed `string[]`; the total record above proves the keys
  // are exactly `PushData['type']`. The guard then drops the sentinel keys.
  (Object.keys(PUSH_HISTORY_DECISIONS) as PushData['type'][]).filter(isRecordedNotificationPush);

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
 * would sit under a switch that never controlled it.
 */
export function notificationHistoryEntryForPushData(
  data: PushData
): NotificationHistoryEntry | null {
  if (!isRecordedNotificationPush(data.type)) return null;
  return {
    pushType: data.type,
    category: PUSH_HISTORY_DECISIONS[data.type](data),
  };
}
