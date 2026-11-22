import { type TOptions } from 'i18next';

import { i18n } from '@/i18n';

/**
 * i18next's `t` with the option object the glanceable messages carry: a count
 * for the plural families, a formatted `{{time}}` for the clock lines.
 *
 * `i18n.t` overloads the two-argument form to require an options object, so the
 * wrapper has to choose the call rather than pass `undefined` through. The
 * headless widget, notification and Live Activity entries each need it with no
 * React context, which is why this lives here and not in a hook.
 */
export function glanceableTranslate(key: string, options?: TOptions): string {
  return options === undefined ? i18n.t(key) : i18n.t(key, options);
}
