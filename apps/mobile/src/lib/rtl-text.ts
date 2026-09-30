import { isValidElement, type ReactNode } from 'react';
import { I18nManager, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

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
 * Applied to a `TextInput` through `withRtlInputAlignment`; the shared
 * single-line field, `@/components/ui/input`, applies it to every single-line
 * input, so a call site does not repeat it. `Text` keeps
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

/** The right-to-left script blocks the app ships: the Hebrew block and its
 * presentation forms, then Arabic, Arabic Supplement, Arabic Extended-B,
 * Arabic Extended-A, and the Arabic Presentation Forms-A and -B. The mono
 * family ships no glyph of either script, so any character in them means the
 * copy needs a font with its glyphs (see `withoutMonoFamily`). */
const RTL_SCRIPT =
  /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Whether a React child tree contains copy in a right-to-left script: the copy
 * the mono family cannot draw, whatever the interface direction is. */
export function hasRtlScript(node: ReactNode): boolean {
  if (Array.isArray(node)) {
    return node.some((child: ReactNode) => hasRtlScript(child));
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return hasRtlScript(node.props.children);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
  if (typeof node === 'string') {
    return RTL_SCRIPT.test(node);
  }
  return false;
}

/**
 * JetBrains Mono ships no Arabic or Hebrew glyphs, so a fallback renders the
 * word one character at a time (`ا س ت ك ش ف`); the system font the app draws
 * its other copy with keeps the joins. The font ships the glyphs of neither
 * script, so the rule is the script and not the interface direction. Drop the
 * `font-mono*` utility, keeping the size, color and weight classes around it.
 */
export function withoutMonoFamily(className: string): string {
  return className
    .split(' ')
    .filter(token => !/^(?:[a-z-]+:)*font-mono(?:-(?:medium|semibold))?$/.test(token))
    .join(' ');
}

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
 * Base layout direction for a `View` whose children are written left to right
 * whatever the interface language — a filesystem path's directory and basename
 * segments are the case in hand. An RTL interface mirrors a `flex-row`, so
 * without this the basename segment draws before the directory; `direction` on
 * the row restores the path's order. This is deliberately not
 * `LTR_TEXT_DIRECTION`: `direction` on a `View` mirrors its children, which is
 * exactly what a path row needs and what a diff gutter's wrapper must not take
 * (see the note above).
 */
export const LTR_LAYOUT_DIRECTION: ViewStyle = { direction: 'ltr' };

/**
 * A joined script's letters connect into one shape, so `letter-spacing` — a
 * Latin display device — opens every glyph from its neighbour and splits a word
 * mid-shape («الوكلاء» draws as «الوكلا ء»). This is the script, not the
 * interface direction: a Latin run inside an Arabic interface (`KiloClaw`,
 * `PR`) joins nothing and keeps its tracking. Arabic, Arabic Supplement,
 * Arabic Extended-B, Arabic Extended-A and the two Arabic Presentation Forms
 * blocks are the ranges a joined Arabic run arrives in. Hebrew is right to
 * left and joins nothing, so it stays out of this range.
 */
export const JOINED_SCRIPT =
  /[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Letter-spacing reset: no added advance between glyphs, what a joined script's
 * shaping expects. `letter-spacing` — Tailwind's `tracking-*` — is a Latin
 * typographic device, so the copy that cannot take it gets this instead. Two
 * rules reach for it in `@/components/ui/text`: a joined script in either
 * direction (see `containsJoinedScript`), and any RTL script the app ships
 * inside an RTL interface, where a Hebrew word would take a spacing no Hebrew
 * reader asked for (see `hasRtlScript`). Latin copy in an RTL interface keeps
 * its tracking.
 *
 * The reset lands in the style array behind the caller's own style, so an
 * explicit `letterSpacing` still wins, and ahead of the class a `className`
 * rule compiles to, so a tracked class stays on the element but draws inert
 * (`text.rtl-tracking.mounted.test.tsx`).
 */
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
 *
 * `@/components/ui/text` reads this to decide the letter-spacing reset, in
 * either interface direction: the joined shape is what the tracking pulls
 * apart.
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
