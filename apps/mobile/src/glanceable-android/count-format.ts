import { i18n } from '@/i18n';
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
