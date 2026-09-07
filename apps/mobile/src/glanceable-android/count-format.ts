import { i18n } from '@/i18n';
import { RTL_LANGUAGES, type SupportedLanguage } from '@/i18n/languages';
import { numberFormat } from '@/lib/intl-cache';

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
