import { i18n } from '@/i18n';
import { GLANCEABLE_STATUS_COPY_KEY } from '@/lib/glanceable/presentation';
import { numberFormat } from '@/lib/intl-cache';

/**
 * Translated copy for the stringified `'widget'` layouts.
 *
 * The widget extension is a separate process that re-evaluates the layout
 * source, so a layout cannot call i18n. The widget families read their copy
 * from the timeline props, but the Live Activity cannot: the notifications
 * Worker pushes the same raw content state and knows no locale, so a
 * background push would draw English on a localized device. The copy is
 * therefore baked into the layout source at registration, the same boundary
 * `withWidgetLogo` uses for the app-group path of the mark.
 */

/**
 * The token the `'widget'` layouts carry until `withGlanceableCopy` resolves
 * it. Each layout repeats this literal inline rather than importing it: the
 * widget transform stringifies the layout source, so an imported binding would
 * be an undefined global in the widget process. `layout-copy.test.ts` keeps
 * the copies equal.
 */
const COPY_PLACEHOLDER = '__KILO_GLANCEABLE_COPY__';

/**
 * Every layout string in the active language, plus the language tag itself.
 *
 * The tag is not copy: the widget process takes its locale from the device
 * language, so a user who overrides the app language would otherwise read
 * translated labels beside a relative wait ("28 min") formatted in the device
 * language. The layouts feed the tag to SwiftUI's `locale` environment value
 * so the whole surface speaks one language.
 *
 * The tag is the underscore form, because `@expo/ui`'s `locale` modifier
 * applies the value only when `Locale.availableIdentifiers` contains it, and
 * that list spells a script or region subtag with an underscore. `zh-Hans`,
 * `zh-Hant` and `pt-BR` failed the check and silently left the wait in the
 * device language, which is the one thing this tag exists to prevent. A
 * numbering-system extension (`ar-u-nu-latn`) fails the same check, so the
 * counts stay in Western digits beside an Arabic-Indic wait; formatting the
 * wait in JS instead would freeze it, because a pushed content state carries
 * only the timestamp.
 *
 * The slot names are the layouts' own field names, and the status slots match
 * `GlanceableAgentsSnapshot['status']` so a layout can index this by status.
 */
export function glanceableLayoutCopy() {
  return {
    waiting: i18n.t(GLANCEABLE_STATUS_COPY_KEY.waiting),
    empty: i18n.t(GLANCEABLE_STATUS_COPY_KEY.empty),
    stale: i18n.t(GLANCEABLE_STATUS_COPY_KEY.stale),
    expired: i18n.t(GLANCEABLE_STATUS_COPY_KEY.expired),
    signed_out: i18n.t(GLANCEABLE_STATUS_COPY_KEY.signed_out),
    privacy: i18n.t(GLANCEABLE_STATUS_COPY_KEY.privacy),
    needsInput: i18n.t('glanceable.needsInput'),
    running: i18n.t('glanceable.running'),
    idle: i18n.t('common.idle'),
    openAgents: i18n.t('glanceable.openAgents'),
    locale: i18n.language.replace('-', '_'),
    digits: glanceableDigits(),
  };
}

/**
 * Resolve the copy placeholder inside a stringified `'widget'` layout.
 *
 * This is the same two-representation boundary as `withWidgetLogo`: Babel's
 * widget plugin replaces a `'widget'` function with a template literal of its
 * source, so the layout is a string in the app while a unit test (which runs
 * no widget transform) still holds the real function. Only the string form
 * carries a placeholder to patch. The replacement includes the surrounding
 * quotes, so `JSON.stringify` produces a correctly escaped source literal for
 * copy that contains an apostrophe.
 */
/**
 * The active language's ten digits, or an empty string when it writes them the
 * way the layout already does.
 *
 * The layout stringifies its counts itself, because a pushed content state
 * carries raw numbers and the widget process has no formatter, so an Arabic
 * row drew "1" beside a wait SwiftUI had formatted as "٢٦ د". Baking the digits
 * lets the layout map its own — one table, every surface, push included.
 */
function glanceableDigits(): string {
  const formatter = numberFormat(i18n.language, { useGrouping: false });
  const digits = Array.from({ length: 10 }, (_, digit) => formatter.format(digit)).join('');
  return digits === '0123456789' ? '' : digits;
}

export function withGlanceableCopy<T>(layout: T): T {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- the two representations are the contract; see above
  if (typeof layout !== 'string') {
    return layout;
  }
  const source = JSON.stringify(JSON.stringify(glanceableLayoutCopy()));
  const patched = layout.split(`'${COPY_PLACEHOLDER}'`).join(source);
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- the layout source IS the component to expo-widgets
  return patched as unknown as T;
}
