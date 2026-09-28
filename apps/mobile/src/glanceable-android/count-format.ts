import { i18n } from '@/i18n';
import { RTL_LANGUAGES, type SupportedLanguage } from '@/i18n/languages';
import { numberFormat } from '@/lib/intl-cache';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * Draw a count in the active language's own digits.
 *
 * Unlike the iOS widget extension, the Android surfaces render in the app's own
 * JS runtime, so `Intl` is already there and no digit table has to be baked into
 * a layout. Grouping is off: these counts never reach four figures, and a
 * separator in a two-character number is only noise.
 */
export function formatGlanceableCount(value: number): string {
  return numberFormat(i18n.language, { useGrouping: false }).format(value);
}

/**
 * Whether the active language reads right to left.
 *
 * `syncRtl` flips the native direction for the app's own views, but a widget
 * draws through the library's own flex engine, which has no direction. The
 * layout mirrors itself from this instead.
 */
export function isWidgetRtl(): boolean {
  return RTL_LANGUAGES.has(i18n.language as SupportedLanguage);
}

/**
 * The relative time the large cell's newest-result footer shows.
 *
 * `timeAgo` already localizes through `Intl.RelativeTimeFormat` and falls back
 * to `common.justNow` for sub-minute ages, so the widget bakes no timer and no
 * second wording. `parseTimestamp` accepts both the ISO strings this app writes
 * and the PostgreSQL form Hermes cannot parse with `new Date`.
 */
export function formatGlanceableAgo(at: string): string {
  return timeAgo(parseTimestamp(at));
}
