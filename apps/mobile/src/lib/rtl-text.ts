import { type ReactNode } from 'react';
import { I18nManager, type StyleProp, type TextStyle } from 'react-native';

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
 * Alignment for a text input's own content. `textAlign: 'auto'` resolves
 * against the paragraph's first strong character, so Latin content stays
 * left-aligned inside a right-to-left interface while the field's label and
 * its neighbours are right-aligned — the sign-in email field showed its
 * `you@example.com` placeholder at the left edge under an Arabic label (device
 * 2026-09-22). Naming the alignment keeps every field on the interface's side,
 * which is what the language search fields already do.
 *
 * Applied to a `TextInput` through `withRtlInputAlignment`; `Text` keeps
 * `RTL_WRITING_DIRECTION` above, which leaves an explicit `text-center` alone.
 * It reaches the input as an inline style, not a class: NativeWind maps
 * `textAlign` to a native prop for `TextInput` and crashes on it in this
 * version, the same reason the language search fields carry theirs inline.
 */
const RTL_INPUT_ALIGNMENT: TextStyle = { textAlign: 'right' };

/** The caller's style with the RTL input alignment in front of it, in RTL only. */
export function withRtlInputAlignment(
  style: StyleProp<TextStyle> | undefined
): StyleProp<TextStyle> | undefined {
  if (!I18nManager.isRTL) {
    return style;
  }
  return [RTL_INPUT_ALIGNMENT, style];
}

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

/**
 * Base direction for code content (a diff line, a hunk header): code is written
 * left to right whatever the interface language. Inheriting the interface's
 * direction instead leaves Android resolving the paragraph's `auto` alignment
 * against RTL, which right-aligns LTR script — the continuation of a wrapped
 * diff line starts mid-row instead of under the first line's start — and
 * reorders a hunk header's runs (`@@ -0,0 +1,82 @@` draws as `@@ 1,82+ 0,0- @@`).
 *
 * `direction` names the base direction Android's paragraph layout reads, and
 * `writingDirection` the same for iOS (see `RTL_WRITING_DIRECTION`). Apply it to
 * the code `Text` itself: `direction` on a wrapping `View` would mirror that
 * view's children too (it would move the diff gutter to the left).
 */
export const LTR_TEXT_DIRECTION: TextStyle = { direction: 'ltr', writingDirection: 'ltr' };

/**
 * A joined script's letters connect into one shape, so `letter-spacing` — a
 * Latin display device — opens every glyph from its neighbour and splits a word
 * mid-shape («الوكلاء» draws as «الوكلا ء»). This is the script, not the
 * interface direction: a Latin run inside an Arabic interface (`KiloClaw`,
 * `PR`) joins nothing and keeps its tracking. Arabic, Arabic Supplement, Arabic
 * Extended-A and the two Arabic Presentation Forms blocks are the ranges a
 * joined Arabic run arrives in.
 */
export const JOINED_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** No added advance between glyphs, what a joined script's shaping expects. */
export const NATURAL_LETTER_SPACING: TextStyle = { letterSpacing: 0 };

/** A `ReactNode` string member, the only child a `Text` lays out as one run. */
function isStringChild(child: ReactNode): child is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode is a closed union; typeof is its string discriminant.
  return typeof child === 'string';
}

/** A `ReactNode` array member; `Array.isArray` alone narrows it to `any[]`. */
function isChildArray(children: ReactNode): children is ReactNode[] {
  return Array.isArray(children);
}

/**
 * Whether a direct string child holds a glyph of a joined script. Array
 * children recurse; a nested `Text` is its own run and applies the rule itself,
 * and numbers, functions and elements are not strings.
 */
export function containsJoinedScript(children: ReactNode): boolean {
  if (isStringChild(children)) {
    return JOINED_SCRIPT.test(children);
  }
  if (isChildArray(children)) {
    return children.some(child => containsJoinedScript(child));
  }
  return false;
}

/** The natural spacing for a joined script, or nothing to override. */
export function textLetterSpacing(children: ReactNode): TextStyle | undefined {
  return containsJoinedScript(children) ? NATURAL_LETTER_SPACING : undefined;
}
