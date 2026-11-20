import { isValidElement, type ReactNode } from 'react';
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

/** The right-to-left mark: a strong character with no width and nothing to speak. */
const RIGHT_TO_LEFT_MARK = '\u200F';

/**
 * Copy whose paragraph must follow the interface's direction instead of its own
 * first strong character, for the case a style cannot reach.
 *
 * Android resolves a paragraph's order from the first strong character it finds
 * and takes `writingDirection` only on iOS, so the Bitbucket note's Arabic
 * sentence — `Bitbucket متاح للمؤسسات فقط.`, which the catalogs translate for
 * every right-to-left language — drew left to right inside a right-aligned
 * line: the product name at the left end and the full stop at the right. A
 * leading right-to-left mark is a strong character with no width and no
 * pronunciation, so the paragraph reads in the interface's direction while the
 * Latin run inside it keeps its own order (`markdown-rtl-list-items.ts` names a
 * list item's start edge the same way).
 *
 * A left-to-right interface gets its copy unchanged: its first strong character
 * already names the direction the interface has.
 *
 * Copy with no right-to-left letter keeps its own order in either interface: a
 * Latin sentence already resolves left to right from its own first letter, and
 * a mark in front of it would take the paragraph the other way — the em dash or
 * the full stop that ends it would move to the other end of the line.
 */
export function withRtlParagraphMark(text: string): string {
  // `RTL_LETTER` carries no `g` flag, so testing it is stateless.
  return I18nManager.isRTL && RTL_LETTER.test(text) ? `${RIGHT_TO_LEFT_MARK}${text}` : text;
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
 * A field value that names something — a path, a command, an identifier — or
 * that is a number: its characters keep their left-to-right order, and the
 * block sits on the same start edge as the label above it.
 *
 * `LTR_TEXT_DIRECTION` covers the order but not the edge. Both platforms
 * resolve a named start edge against the node's own layout direction, and this
 * node pins that direction to left to right
 * (`TextAttributeProps.getTextAlignment`, `RCTResolveTextAlignment`), so a
 * relative alignment would resolve against the pinned direction and the value
 * would stay at the far left under a right-aligned label. The physical right
 * edge is the start edge in a right-to-left interface, and it is the one value
 * that lands there on both: `TextInput` maps `'start'` to `Gravity.START` but
 * `'right'` to `Gravity.RIGHT` on Android, and the other platform resolves both
 * names against the pinned direction, where only `'right'` reaches that edge.
 *
 * Read per call, not at module load: the interface direction is a runtime
 * setting the app can change without reloading this module.
 */
export function ltrValueTextStyle(): TextStyle {
  return I18nManager.isRTL ? { ...LTR_TEXT_DIRECTION, textAlign: 'right' } : LTR_TEXT_DIRECTION;
}

/**
 * A field whose value is code (a shell command, a config line): the value keeps
 * its left-to-right order and its left edge in every interface. Unlike a named
 * value (`ltrValueTextStyle`), which sits on the label's start edge, a command
 * reads from the left and must not follow a right-aligned label in a
 * right-to-left interface.
 *
 * The family's default ligatures are switched off as well: JetBrains Mono draws
 * the `--` of a flag as one long dash, so `pnpm install --frozen-lockfile` reads
 * as prose dashes instead of the two hyphens the shell needs. These are the
 * feature names the platform's text stack recognises; a face without them
 * ignores the request.
 */
export function codeFieldTextStyle(): TextStyle {
  return {
    ...LTR_TEXT_DIRECTION,
    textAlign: 'left',
    fontVariant: ['no-common-ligatures', 'no-discretionary-ligatures', 'no-contextual'],
  };
}

/** A letter: the strong characters a paragraph's direction resolves from. */
const LETTER = /\p{L}/u;

/** The first letter of a React child tree, or `undefined` when it has none. */
function firstLetter(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const letter = firstLetter(child);
      if (letter !== undefined) {
        return letter;
      }
    }
    return undefined;
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return firstLetter(node.props.children);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
  if (typeof node === 'string') {
    return LETTER.exec(node)?.[0];
  }
  return undefined;
}

/**
 * The code point ranges whose letters are right to left (bidi class R or AL):
 * Hebrew through Arabic Extended-A, the Hebrew and Arabic presentation forms,
 * and the two supplementary areas Unicode reserves for right-to-left scripts
 * (U+10800-U+10FFF, Cypriot Syllabary through Elymaic and Arabic Extended-C;
 * U+1E800-U+1EFFF, Mende Kikakui through the Arabic mathematical symbols).
 * Every letter in these ranges is R or AL, Cypriot, Lydian and Meroitic
 * included. Unlike `RTL_SCRIPT`, which lists the scripts the app has glyphs
 * for, this covers every right-to-left script content can arrive in — Syriac,
 * Thaana, NKo, Samaritan, Mandaic, Adlam. Only a letter is tested, so the few
 * neutral code points in these ranges never decide a direction.
 */
const RTL_LETTER =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

const CONTENT_RTL_DIRECTION: TextStyle = { direction: 'rtl', writingDirection: 'rtl' };

/**
 * Base direction for copy the app did not write — a server's message, a user's
 * own text, an issue body. The paragraph takes the direction of its own first
 * letter, so English content keeps its left edge and the punctuation that ends
 * it inside a right-to-left interface, and Arabic content still aligns to the
 * right. `undefined` when the copy has no letter: it then keeps the interface's
 * direction.
 *
 * The text node's own layout `direction` is named as well as its
 * `writingDirection`. iOS takes a paragraph's alignment from the node's layout
 * direction, not from its writing direction: Fabric reads the Yoga node's
 * resolved direction into `layoutDirection` (`ParagraphShadowNode.cpp`), and
 * `RCTResolveTextAlignment` (`RCTAttributedTextUtils.mm`) turns natural into
 * right and swaps left and right whenever that direction is right to left. So
 * `writingDirection` alone fixed an English description's punctuation but left
 * it on the right edge of an Arabic screen. Pinning the node's direction to the
 * copy's own makes the natural alignment resolve to the copy's start edge on
 * both platforms (Android resolves gravity against the same direction), and
 * unlike `textAlign` it leaves an explicit `text-center` alone. It is set on
 * the `Text` itself, so the box still sits where the interface's flexbox puts it.
 */
export function contentTextDirection(children: ReactNode): TextStyle | undefined {
  const letter = firstLetter(children);
  if (letter === undefined) {
    return undefined;
  }
  return RTL_LETTER.test(letter) ? CONTENT_RTL_DIRECTION : LTR_TEXT_DIRECTION;
}

/**
 * A joined script's letters connect into one shape, so `letter-spacing` — a
 * Latin display device — opens every glyph from its neighbour and splits a word
 * mid-shape («الوكلاء» draws as «الوكلا ء»). This is the script, not the
 * interface direction: a Latin run inside an Arabic interface (`Kilo`,
 * `PR`) joins nothing and keeps its tracking. Arabic, Arabic Supplement,
 * Arabic Extended-B, Arabic Extended-A and the two Arabic Presentation Forms
 * blocks are the ranges a joined Arabic run arrives in. Hebrew is right to
 * left and joins nothing, so it stays out of this range.
 *
 * The Brahmic scripts combine instead of joining, with the same effect: a
 * vowel sign or virama shapes onto its consonant as one cluster, and tracking
 * pulls the cluster apart («இப்போது» draws as «இ ப் போ து»). U+0900-U+0DFF
 * covers Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu,
 * Kannada, Malayalam and Sinhala; U+0E00-U+0EFF Thai and Lao; U+1000-U+109F
 * Myanmar; U+1780-U+17FF Khmer.
 */
export const JOINED_SCRIPT =
  /[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u0DFF\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF]/;

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
