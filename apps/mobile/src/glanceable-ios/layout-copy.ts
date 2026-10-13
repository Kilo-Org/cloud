import { i18n } from '@/i18n';
import { GLANCEABLE_STATUS_COPY_KEY } from '@/lib/glanceable/presentation';
import { formatCurrency } from '@/lib/format';
import { numberFormat } from '@/lib/intl-cache';

/**
 * Translated copy for the stringified `'widget'` layouts.
 *
 * The widget extension is a separate process that re-evaluates the layout
 * source, so a layout cannot call i18n. The widget families read their copy
 * from the timeline props, but the Live Activity cannot: the notifications
 * Worker pushes the same raw content state and knows no locale, so a
 * background push would draw English on a localized device. The copy is
 * therefore baked into the layout source at registration.
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
    running: i18n.t('common.working'),
    scheduled: i18n.t('common.scheduled'),
    idle: i18n.t('common.idle'),
    // The session card's idle label and its Open control.
    finished: i18n.t('glanceable.finished'),
    open: i18n.t('glanceable.openSession'),
    openAgents: i18n.t('glanceable.openAgents'),
    // The Live Activity's button and the widget's in-place actions all read
    // `common.approve`: the permission card, the wrist control, and the widget
    // button name the same action, and `check:i18n` forbids a second key with the
    // same copy. The action copy is baked, not pushed through props: a card
    // started by a server push carries no copy at all.
    approve: i18n.t('common.approve'),
    newAgent: i18n.t('glanceable.newAgent'),
    checked: i18n.t('glanceable.checked'),
    lastKnown: i18n.t('glanceable.lastKnown'),
    awaitingUpdate: i18n.t('glanceable.awaitingUpdate'),
    nextRun: i18n.t('glanceable.nextRun'),
    agent: i18n.t('common.agent'),
    // The Home tile's empty state reads the key the Android Home widget and the
    // in-app Home card read, so an empty account is worded the same everywhere.
    homeEmpty: i18n.t('home.noLiveSessions'),
    waitingForYou: i18n.t('glanceable.waitingForYou'),
    permissionRequired: i18n.t('agentChat.permissionCard.title'),
    answerNeeded: i18n.t('glanceable.answerNeeded'),
    waitingToRetry: i18n.t('glanceable.waitingToRetry'),
    // Home widget slots added with the redesign; the Live Activity reads none of them.
    // The session card's step, plan, outcome and failure copy.
    editing: i18n.t('glanceable.step.editing'),
    reading: i18n.t('glanceable.step.reading'),
    stepRunning: i18n.t('glanceable.step.running'),
    searching: i18n.t('glanceable.step.searching'),
    thinking: i18n.t('glanceable.step.thinking'),
    of: i18n.t('glanceable.planOf'),
    filesChanged: i18n.t('glanceable.filesChanged'),
    finishedIn: i18n.t('glanceable.finishedIn'),
    minute: i18n.t('common.durationMinuteShort'),
    hour: i18n.t('common.durationHourShort'),
    noActivity: i18n.t('glanceable.noActivityFor'),
    prOpened: i18n.t('glanceable.prOpened'),
    failed: i18n.t('common.failed'),
    failureProvider: i18n.t('glanceable.failure.provider'),
    failureTool: i18n.t('glanceable.failure.tool'),
    failureCancelled: i18n.t('glanceable.failure.cancelled'),
    failureOther: i18n.t('glanceable.failure.other'),
    permissionWants: i18n.t('glanceable.permissionWants'),
    approving: i18n.t('glanceable.approving'),
    couldNotApprove: i18n.t('glanceable.couldNotApprove'),
    approveFailed: i18n.t('glanceable.approveFailed'),
    recent: i18n.t('common.recent'),
    nextScheduled: i18n.t('glanceable.nextScheduled'),
    group: glanceableGroupSeparator(),
    ...glanceableCostFormat(),
    locale: resolveGlanceableLocale(i18n.language),
    digits: glanceableDigits(),
  };
}

/**
 * App languages whose catalog script differs from the script a bare language
 * tag makes SwiftUI pick. Serbian ships a Latin catalog here, but a bare `sr`
 * tag formats the relative wait in Cyrillic ("мин"), beside Latin labels. The
 * override names the script; `resolveGlanceableLocale` normalizes it.
 */
function glanceableLocaleScriptOverride(language: string): string | undefined {
  if (language === 'sr') {
    return 'sr-Latn';
  }
  return undefined;
}

/**
 * The SwiftUI locale tag for an app language, in the underscore form the
 * `@expo/ui` locale modifier accepts (see the note on `glanceableLayoutCopy`).
 * Languages that write a non-default script for their tag are mapped so the
 * relative wait uses the same script as the baked labels.
 */
export function resolveGlanceableLocale(language: string): string {
  return (glanceableLocaleScriptOverride(language) ?? language).replace('-', '_');
}

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

/**
 * The active language's thousands separator, or an empty string when it has
 * none or writes more than one character there. The widget process has no
 * formatter, so the Home layout groups its own counts with this ("1,234",
 * "1.234", "١٬٢٣٤").
 */
function glanceableGroupSeparator(): string {
  const grouped = numberFormat(i18n.language, { useGrouping: true }).format(10_000);
  const separator = grouped.slice(2, -3);
  return separator.length === 1 ? separator : '';
}

/** A sample amount whose localized number part the cost template replaces. */
const COST_SAMPLE = 1.25;

/**
 * The session cost format in the active language, for the widget process,
 * which has no formatter: the currency template around the amount ("$#",
 * "# $", "US$ #"), with `#` where the number goes, and the decimal separator.
 * The template comes from the app's own cost formatter, so the card shows the
 * currency symbol the app shows everywhere else. Empty slots mean the
 * template could not be read, and the layout falls back to "$#" and ".".
 */
type GlanceableCostFormat = { costTemplate: string; costDecimal: string };

function glanceableCostFormat(): GlanceableCostFormat {
  const sample = formatCurrency(COST_SAMPLE, i18n.language, 2);
  const amount = numberFormat(i18n.language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(COST_SAMPLE);
  const at = sample.indexOf(amount);
  if (at === -1 || amount.length !== 4) {
    return { costTemplate: '', costDecimal: '' };
  }
  return {
    costTemplate: `${sample.slice(0, at)}#${sample.slice(at + amount.length)}`,
    costDecimal: amount.slice(1, 2),
  };
}

/**
 * Resolve the copy placeholder inside a stringified `'widget'` layout.
 *
 * This is a two-representation boundary: Babel's
 * widget plugin replaces a `'widget'` function with a template literal of its
 * source, so the layout is a string in the app while a unit test (which runs
 * no widget transform) still holds the real function. Only the string form
 * carries a placeholder to patch. The replacement includes the surrounding
 * quotes, so `JSON.stringify` produces a correctly escaped source literal for
 * copy that contains an apostrophe.
 */
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
