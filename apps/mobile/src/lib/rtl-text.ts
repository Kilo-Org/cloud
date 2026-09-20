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

/**
 * Letter-spacing — Tailwind's `tracking-*` — is a Latin typographic device:
 * it opens every glyph from its neighbour. The RTL scripts the app ships do
 * not take it. An Arabic-script word is one connected shape, so a tracked
 * label breaks its joins and renders the letters as isolated forms
 * ('استكشف'); a letter-spacing of 0 keeps the paragraph's natural spacing.
 *
 * `@/components/ui/text` applies this to everything that goes through it, in
 * the same RTL style array as `RTL_WRITING_DIRECTION`, so a tracked class the
 * LTR design owns stays in the className and simply has no effect in RTL.
 */
export const RTL_NO_LETTER_SPACING: TextStyle = { letterSpacing: 0 };

/** The caller's style with the RTL paragraph direction behind it, in RTL only. */
export function withRtlWritingDirection(style: TextStyle | undefined): TextStyle | undefined {
  if (!I18nManager.isRTL) {
    return style;
  }
  return style ? { ...RTL_WRITING_DIRECTION, ...style } : RTL_WRITING_DIRECTION;
}
