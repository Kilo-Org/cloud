import { type ReactNode } from 'react';
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

/**
 * Arabic, Arabic Supplement, Arabic Extended-A, and the two Arabic
 * Presentation Forms blocks. The interface's joined-script languages (Arabic,
 * Farsi, Urdu, Kurdish, Pashto) all write in this script, and Arabic text
 * quoted inside any other catalog does too.
 */
const JOINED_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Letter spacing stays at its natural width on a joined script: tracking is an
 * uppercase-Latin affordance, and on Arabic it inserts space between letters
 * that must stay joined, tearing the word apart (seen on the Preferences
 * section labels). The script, not the interface direction, decides — Hebrew
 * is right-to-left but does not join, and an Arabic run in an English
 * interface joins the same way.
 *
 * Only this `Text` node's own string children are read: a nested `Text` is its
 * own run and applies this on its own.
 */
export const NATURAL_LETTER_SPACING: TextStyle = { letterSpacing: 0 };

/** True when any direct string child of a text node holds a joined-script glyph. */
export function containsJoinedScript(children: ReactNode): boolean {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to reach its plain-string leaf
    typeof children === 'string'
  ) {
    return JOINED_SCRIPT.test(children);
  }
  if (Array.isArray(children)) {
    return children.some(child => containsJoinedScript(child as ReactNode));
  }
  return false;
}

/** The letter-spacing override a text run needs, or `undefined` when Latin tracking is safe. */
export function textLetterSpacing(children: ReactNode): TextStyle | undefined {
  return containsJoinedScript(children) ? NATURAL_LETTER_SPACING : undefined;
}
