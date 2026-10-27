import {
  NOTIFICATION_HISTORY_CATEGORIES,
  type NotificationHistoryCategory,
  type PushData,
  pushDataSchema,
  translatePush,
} from '@kilocode/notifications';

import { notificationPathForData } from './notification-path';

/**
 * Pure logic for the Notification history screen: how a recorded row is read
 * back, where a row's tap goes, and which filter chips the list offers.
 *
 * The row is rendered on the device from the catalog key and params the push
 * carried, in the app's current language, so a row reads like the notification
 * did. The worker's own renderer does the same with its per-token locale
 * (`NotificationChannelDO.dispatchPush`); the stored fallback copy is what a
 * removed key falls back to.
 */

/** The stored fields a row's copy is rendered from. */
export type NotificationHistoryCopyFields = Readonly<{
  /** Catalog key without a `.title`/`.body` suffix, or null for a raw-form push. */
  i18nKey: string | null;
  i18nParams: Record<string, string> | null;
  /** The copy the sender stored, used verbatim when no key resolves. */
  title: string;
  body: string;
}>;

/** The rendered title and body of one row. */
export type NotificationHistoryCopy = Readonly<{ title: string; body: string }>;

/**
 * The row's title and body in `locale`. A row with no catalog key, or whose key
 * is no longer in the push catalog, keeps the stored fallback copy — never the
 * content-free preview copy, which is a per-device send-time setting and is
 * never what was recorded.
 */
export function notificationHistoryCopy(
  row: NotificationHistoryCopyFields,
  locale: string
): NotificationHistoryCopy {
  if (row.i18nKey === null) {
    return { title: row.title, body: row.body };
  }
  const params = row.i18nParams ?? undefined;
  return {
    title: translatePush(locale, `${row.i18nKey}.title`, params, row.title),
    body: translatePush(locale, `${row.i18nKey}.body`, params, row.body),
  };
}

export type NotificationHistoryTarget = Readonly<{
  data: PushData;
  href: string;
}>;

/**
 * Drop the `via=push` marker from a destination. The marker tags the landing
 * screen's analytics event as push-originated, and opening a row from the list
 * is not a push tap.
 */
function withoutPushOrigin(href: string): string {
  const queryStart = href.indexOf('?');
  if (queryStart === -1) {
    return href;
  }
  const kept = href
    .slice(queryStart + 1)
    .split('&')
    .filter(part => part !== 'via=push');
  if (kept.length === 0) {
    return href.slice(0, queryStart);
  }
  return `${href.slice(0, queryStart)}?${kept.join('&')}`;
}

/**
 * Where a row's tap goes, or null when the stored payload no longer resolves to
 * a destination (a producer shape this app cannot parse). A null target is the
 * one dead destination the list can detect without a request: every recorded
 * kind maps to a route.
 */
export function notificationHistoryTarget(
  payload: Record<string, unknown>
): NotificationHistoryTarget | null {
  const parsed = pushDataSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return { data: parsed.data, href: withoutPushOrigin(notificationPathForData(parsed.data)) };
}

export type NotificationHistoryFilter = Readonly<{
  /** null is the unfiltered "All" chip. */
  category: NotificationHistoryCategory | null;
  labelKey: string;
}>;

/**
 * Chip label per recorded category. The settings screen's own wording, so a
 * chip and the switch that governs it read the same. Keys are literal so the
 * catalog check can see them.
 */
const CATEGORY_LABEL_KEYS = {
  chatMessages: 'notifications.channel.chat',
  agentAttention: 'notifications.category.agentAttentionTitle',
  sessionStatus: 'notifications.category.sessionStatusTitle',
  balanceAlerts: 'notifications.channel.balance',
  spendAlerts: 'notifications.channel.spend',
  securityFindings: 'notifications.channel.security',
} satisfies Record<NotificationHistoryCategory, string>;

/**
 * Every chip in the order the settings screen lists the categories: "All"
 * first, then one per category the recorder can produce. A category the
 * recorder never writes (there is no recorded push kind for it) has no chip,
 * so no chip can only ever answer an empty page.
 */
export const NOTIFICATION_HISTORY_FILTERS: readonly NotificationHistoryFilter[] = [
  { category: null, labelKey: 'common.all' },
  ...NOTIFICATION_HISTORY_CATEGORIES.map(category => ({
    category,
    labelKey: CATEGORY_LABEL_KEYS[category],
  })),
];

/**
 * The chips an account can use: a category the server marks unavailable (no
 * organization, no security agent) is dropped rather than offered as a control
 * that can only return an empty page. Availability the client has not read yet
 * — or could not read — keeps the chip, so a failed preferences query never
 * hides a filter the account does have.
 */
export function notificationHistoryFilters(
  capabilities: Readonly<Record<string, { available: boolean }>> | undefined
): readonly NotificationHistoryFilter[] {
  return NOTIFICATION_HISTORY_FILTERS.filter(
    filter => filter.category === null || capabilities?.[filter.category]?.available !== false
  );
}
