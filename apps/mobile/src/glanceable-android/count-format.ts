import { getCalendars } from 'expo-localization';
import { i18n } from '@/i18n';
import { RTL_LANGUAGES, type SupportedLanguage } from '@/i18n/languages';
import { dateTimeFormat, numberFormat } from '@/lib/intl-cache';
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
 * The relative time an Android glanceable draws: the large cell's newest-result
 * footer, and the ongoing notification's scheduled wake.
 *
 * `timeAgo` already localizes through `Intl.RelativeTimeFormat` and falls back
 * to `common.justNow` for sub-minute ages, so the widget bakes no timer and no
 * second wording. It is direction-aware too, so a scheduled wake ahead of the
 * clock reads "in 2 hours" rather than the "Just now" a past-only read would
 * give. `parseTimestamp` accepts both the ISO strings this app writes and the
 * PostgreSQL form Hermes cannot parse with `new Date`.
 */
export function formatGlanceableAgo(at: string): string {
  return timeAgo(parseTimestamp(at));
}

/** Checked dates stay absolute because a widget bitmap cannot advance a relative age offline. */
export function formatGlanceableClock(at: string, options?: { includeDate: boolean }): string {
  const date = parseTimestamp(at);
  const now = new Date();
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const uses24hourClock = getCalendars().at(0)?.uses24hourClock ?? null;
  return dateTimeFormat(i18n.language, {
    ...(today && !options?.includeDate
      ? { timeStyle: 'short' as const }
      : { dateStyle: 'short' as const, timeStyle: 'short' as const }),
    ...(uses24hourClock === null
      ? {}
      : { hourCycle: uses24hourClock ? ('h23' as const) : ('h12' as const) }),
  }).format(date);
}
