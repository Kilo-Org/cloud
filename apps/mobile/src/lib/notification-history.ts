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

/** The two lines a row draws: the line beside the timestamp, and the message under it. */
export type NotificationHistoryCopy = Readonly<{
  /** The first line: the message itself when the title only names the app. */
  headline: string;
  /** The message under the headline, or null when the headline is the message. */
  detail: string | null;
}>;

/** The catalog entry whose title is the product name alone, in every locale. */
const APP_NAME_TITLE_KEY = 'generic.title';

/** One stored field, translated through its catalog entry when the row has a key. */
function translatedPart(
  row: NotificationHistoryCopyFields,
  locale: string,
  part: 'title' | 'body'
): string {
  const stored = row[part];
  return row.i18nKey === null
    ? stored
    : translatePush(locale, `${row.i18nKey}.${part}`, row.i18nParams ?? undefined, stored);
}

/**
 * The row's two lines in `locale`. A row with no catalog key, or whose key is no
 * longer in the push catalog, keeps the stored fallback copy — never the
 * content-free preview copy, which is a per-device send-time setting and is
 * never what was recorded.
 *
 * A title that is only the app name adds nothing to a screen the app draws, so
 * the message leads that row alone; a title naming the event (a session, a
 * conversation, an alert) keeps the headline it had. The push catalog writes
 * the former as the bare product name (`generic`, the security lifecycle
 * notice), so the test is a comparison with the same catalog's spelling in
 * `locale` — `I-Kilo` in Zulu, `Kilo` elsewhere — taken from the title template
 * with its params left out: a session the user named "Kilo" keeps its title,
 * because its template is the session name.
 */
export function notificationHistoryCopy(
  row: NotificationHistoryCopyFields,
  locale: string
): NotificationHistoryCopy {
  const title = translatedPart(row, locale, 'title');
  const body = translatedPart(row, locale, 'body');
  const titleTemplate = translatedPart({ ...row, i18nParams: null }, locale, 'title');
  return titleTemplate.trim() === translatePush(locale, APP_NAME_TITLE_KEY).trim()
    ? { headline: body, detail: null }
    : { headline: title, detail: body };
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
