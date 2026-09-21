import { isValidElement, type ReactNode } from 'react';
import { I18nManager, type TextStyle } from 'react-native';

/**
 * RN 0.86 does not resolve `textAlign: 'auto'` from the native layout
 * direction on iOS, so text that fills its box stays left-aligned in an RTL
 * interface while the flexbox around it mirrors correctly. Naming the
 * paragraph's base direction makes the natural alignment resolve, and unlike
 * `textAlign` it leaves an explicit `text-center` alone.
 *
 * `@/components/ui/text` applies this to everything that goes through it.
 * The markdown renderer builds its `Text` nodes with `createElement` and its
 * own computed styles, so it reaches for the same constant rather than
 * inheriting the component.
 */
export const RTL_WRITING_DIRECTION: TextStyle = { writingDirection: 'rtl' };

/** The caller's style with the RTL paragraph direction behind it, in RTL only. */
export function withRtlWritingDirection(style: TextStyle | undefined): TextStyle | undefined {
  if (!I18nManager.isRTL) {
    return style;
  }
  return style ? { ...RTL_WRITING_DIRECTION, ...style } : RTL_WRITING_DIRECTION;
}

// The Arabic blocks (U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF) plus the
// Arabic presentation forms (U+FB50-U+FDFF, U+FE70-U+FEFF), so a label copied
// with shaped glyphs is recognised too. No `g` flag: `.test` must stay
// stateless across calls.
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/**
 * Whether any text a node renders is Arabic. A string is tested directly, an
 * array when any of its items is, and an element when its children are; a
 * label that mixes scripts is Arabic enough for the treatment below.
 */
export function hasArabicScript(node: ReactNode): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode is a mixed union of string, element, array and null; typeof is the only way to separate a string child before recursing into an element's children
  if (typeof node === 'string') {
    return ARABIC_SCRIPT.test(node);
  }
  if (Array.isArray(node)) {
    return hasArabicScriptIn(node);
  }
  if (isValidElement(node)) {
    return hasArabicScript((node.props as { children?: ReactNode }).children);
  }
  return false;
}

/** Whether any node in a child list carries Arabic script. */
function hasArabicScriptIn(nodes: readonly ReactNode[]): boolean {
  return nodes.some(node => hasArabicScript(node));
}

// One Latin-only label treatment, matched against a whole Tailwind token: the
// mono family, or any `tracking-*` letter-spacing utility, optionally behind a
// variant prefix such as `rtl:`.
const LATIN_LABEL_TREATMENT =
  /^(?:font-mono|font-mono-medium|font-mono-semibold|(?:[a-z-]+:)?tracking-(?:\[[^\]]+\]|tight|normal|wide|wider|widest))$/;

/**
 * The classes without the Latin label treatment. Letter-spacing opens the
 * joins of an Arabic word, which is one connected shape, and JetBrains Mono
 * ships no Arabic glyphs, so Android draws the fallback one character at a
 * time. `uppercase` stays: a caseless script cannot show it, and a Latin run
 * inside the same label keeps its designed capitals.
 */
export function withoutLatinLabelTreatment(className: string): string {
  return className
    .split(' ')
    .filter(token => !LATIN_LABEL_TREATMENT.test(token))
    .join(' ');
}
