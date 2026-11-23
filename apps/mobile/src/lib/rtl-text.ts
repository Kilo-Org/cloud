/* oxlint-disable max-lines -- the direction, script, joining, and mark rules one message's copy is laid out with share fixtures and must read together */
import { createElement, Fragment, isValidElement, type ReactNode } from 'react';
import { I18nManager, type StyleProp, StyleSheet, type TextStyle } from 'react-native';

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
 * Whether copy keeps its capitalised, letterspaced display treatment. Latin
 * copy keeps it in either direction; right-to-left-script copy drops it in a
 * right-to-left interface, where capitals mean nothing and the tracking breaks
 * the script's joins. The interface direction alone never decides it, so the
 * same Latin copy takes one look in both directions.
 *
 * The caller passes `hasRtlScript` of its own copy because the shared `Text`
 * primitive already scans its children once and memoizes the result; taking the
 * boolean keeps that scan out of this rule's callers.
 */
export function keepsLatinDisplay(isRtlScriptCopy: boolean): boolean {
  return !(I18nManager.isRTL && isRtlScriptCopy);
}

/**
 * JetBrains Mono draws neither the right-to-left blocks the app ships
 * (`RTL_SCRIPT`: Hebrew, and Arabic with its supplement, extended and
 * presentation blocks) nor any of the joined scripts `JOINED_SCRIPT` lists
 * (the Brahmic blocks, Thai, Lao, Myanmar, Khmer). Every character of that copy
 * falls to a fallback font, which lays each glyph out on its own: an Arabic word
 * loses its joins (`ا س ت ك ش ف`) and a Brahmic, Thai, Lao, Myanmar or Khmer
 * cluster comes apart between the base letter and its vowel signs. The system
 * font the app draws its other copy with keeps both shapes, so the rule is the
 * script and not the interface direction: whichever set holds the copy, drop
 * the `font-mono*` utility and keep the size, color and weight classes around
 * it.
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
 * Base direction for copy written right to left: the twin of
 * `LTR_TEXT_DIRECTION`, naming both spellings for the same reason.
 */
export const RTL_TEXT_DIRECTION: TextStyle = { direction: 'rtl', writingDirection: 'rtl' };

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

/**
 * A strong character: the character a paragraph's direction resolves from, the
 * bidi algorithm's strong type. Only a letter counts. A direction mark names a
 * direction itself, but it draws and speaks nothing, so letting one decide
 * flips a whole block on a character the reader cannot see — which is exactly
 * how the design gate's markdown fallback block ended up with one of its rows
 * on each edge. A mark is stripped instead (`withoutLeadingDirectionMarks`).
 */
const STRONG = /\p{L}/u;

/** The first strong character of a React child tree, or `undefined` when it has none. */
function firstStrong(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const strong = firstStrong(child);
      if (strong !== undefined) {
        return strong;
      }
    }
    return undefined;
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return firstStrong(node.props.children);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
  if (typeof node === 'string') {
    return STRONG.exec(node)?.[0];
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

/** The base direction a strong character names, or `undefined` when there is none. */
function directionOfStrong(strong: string | undefined): 'ltr' | 'rtl' | undefined {
  if (strong === undefined) {
    return undefined;
  }
  return RTL_LETTER.test(strong) ? 'rtl' : 'ltr';
}

/**
 * The paragraph style that names each base direction, from the shared
 * constants above. A caller that has resolved a direction to `'ltr'` or
 * `'rtl'` picks the style here rather than rebuilding it.
 */
export const DIRECTION_TEXT_STYLES = {
  ltr: LTR_TEXT_DIRECTION,
  rtl: RTL_TEXT_DIRECTION,
} as const;

/**
 * Base direction for copy the app did not write — a server's message, a user's
 * own text, an issue body. The paragraph takes the direction of its own first
 * letter, so English content keeps its left edge and the punctuation that ends
 * it inside a right-to-left interface, and Arabic content still aligns to the
 * right. A leading direction mark is not a strong character, so it never names
 * the direction here. `undefined` when the copy holds no letter: it then keeps
 * the interface's direction, and a markdown block in that position takes the
 * message's own direction instead (`markdownMessageDirection`).
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
  const direction = directionOfStrong(firstStrong(children));
  return direction === undefined ? undefined : DIRECTION_TEXT_STYLES[direction];
}

/**
 * The base direction a block's own text names, from its first letter, or
 * `undefined` when it holds none. `contentTextDirection` for copy that arrives
 * as a string rather than as a React child tree — an HTML block's own text,
 * which no element wraps. The caller picks the style
 * (`DIRECTION_TEXT_STYLES`) or falls back to the message's direction.
 */
export function contentStringDirection(text: string): 'ltr' | 'rtl' | undefined {
  return directionOfStrong(STRONG.exec(text)?.[0]);
}

/**
 * `text` without the markup and inline code a reader never reads as words, and
 * with every other character left as written.
 *
 * Two shapes need more than a regex to skip whole. An HTML tag's quoted
 * attribute may hold a `>` (`<a title="a>b">مرحبا`), so the scan tracks the
 * quote it is inside instead of stopping at the first `>`. A code span opens on
 * a run of N backticks and closes on the next run of exactly N, so its content
 * may hold a shorter run (`` ``a`b`` ``); a one-backtick regex matched the empty
 * ` `` ` pair there and let the span's own letters decide the message.
 *
 * Both are machinery: a tag name and code are Latin whatever language the
 * message is in, so neither may name the message's direction.
 */
function withoutMarkup(text: string): string {
  const kept: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '<') {
      index = skipTag(text, index);
    } else if (char === '`') {
      index = skipCodeSpan(text, index);
    } else {
      kept.push(char ?? '');
      index += 1;
    }
  }
  return kept.join('');
}

/**
 * The offset past the HTML tag that starts at `start`, or past the `<` alone
 * when no tag closes on this line. A quoted attribute value is skipped whole,
 * so a `>` inside one does not end the tag.
 */
function skipTag(text: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') {
      // A tag never spans a line: this `<` was comparison or copy.
      return start + 1;
    }
    if (quote === null) {
      if (char === '>') {
        return index + 1;
      }
      if (char === '"' || char === "'") {
        quote = char;
      }
    } else if (char === quote) {
      quote = null;
    }
  }
  return start + 1;
}

/**
 * The offset past the code span that opens at `start`, where the opening run is
 * `start`'s backticks; or past the run alone when no run of exactly that length
 * closes it (a streaming tail, or backticks written as copy).
 */
function skipCodeSpan(text: string, start: number): number {
  let opening = 1;
  while (text[start + opening] === '`') {
    opening += 1;
  }
  let index = start + opening;
  while (index < text.length) {
    const char = text[index];
    // A code span stays on its line: a run that does not close before the line
    // ends is the content's own backticks, not a span.
    if (char === '\n') {
      return start + opening;
    }
    if (char !== '`') {
      index += 1;
    } else {
      let closing = 1;
      while (text[index + closing] === '`') {
        closing += 1;
      }
      if (closing === opening) {
        return index + closing;
      }
      index += closing;
    }
  }
  return start + opening;
}

/** A link or image destination: a URL, not the message's prose. The label
 * before it stays, because a label is copy a person reads. */
const LINK_DESTINATION = /\]\([^)\n]*\)/g;

/** A bare URL, which opens a message on a Latin host name. */
const BARE_URL = /\b(?:https?|ftp|mailto):\S+/gi;

/** A link reference definition line, whose destination is a URL. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]/;

/** A table's delimiter row: dashes and colons, no copy. */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t:-]*-[ \t:-]*\|?[ \t]*$/;

/**
 * The prose of `markdown`: everything a reader takes as the message's words.
 * Code (fenced, indented, and inline), link and image destinations, bare URLs,
 * link reference definitions, table delimiters and HTML markup are all
 * machinery, and machinery is Latin whatever language the message is in, so a
 * message that opens with a fence or a URL still names the direction of the
 * Arabic prose after it.
 */
function markdownProse(markdown: string): string {
  const prose: string[] = [];
  let inFence = false;
  let previousBlank = true;
  for (const line of markdown.split('\n')) {
    const body = line.slice(BLOCKQUOTE_START.exec(line)?.[0].length ?? 0);
    const opensFence = FENCE_START.test(body);
    const blank = body.trim().length === 0;
    const indentedCode = previousBlank && INDENTED_CODE.test(body);
    if (!inFence && !opensFence && !indentedCode && !TABLE_DELIMITER.test(body)) {
      prose.push(body);
    }
    if (opensFence) {
      inFence = !inFence;
    }
    previousBlank = blank;
  }
  return withoutMarkup(prose.filter(line => !REFERENCE_DEFINITION.test(line)).join('\n'))
    .replace(LINK_DESTINATION, ']')
    .replace(BARE_URL, '');
}

/**
 * The base direction a markdown message names, from its first prose letter
 * (`markdownProse`), or `undefined` when the whole message holds no prose
 * letter.
 *
 * This is the direction a block that holds no letter of its own takes: the one
 * rule for a message is its own first letter's direction, so a message of
 * `42 · 7`, an HTML paragraph of Latin text and a bullet of Latin text all sit
 * on one edge, instead of each falling back to the interface's edge while a
 * lettered block next to it names its own. The design gate measured exactly
 * that zig-zag: the middle row of the markdown fallback block started on the
 * left while the rows above and below it stayed right.
 */
export function markdownMessageDirection(markdown: string): 'ltr' | 'rtl' | undefined {
  return directionOfStrong(STRONG.exec(markdownProse(markdown))?.[0]);
}

/** A direction mark: the Arabic letter mark and the left-to-right and
 * right-to-left marks. They draw and speak nothing, so in front of a block's
 * first character their only effect is to name that block's edge. */
const DIRECTION_MARK = /[\u061C\u200E\u200F]/;

/** A run of direction marks, matched where a block's opening run reaches it.
 * Sticky: the walk asks whether the run starts at one offset and nowhere else. */
const DIRECTION_MARK_RUN = /[\u061C\u200E\u200F]+/y;

/** A line's blockquote markers, `>` or `> `, nested. */
const BLOCKQUOTE_START = /^(?: {0,3}>[ \t]?)+/;

/** A list item's marker and the space after it: a bullet, or an ordered number. */
const LIST_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** An ATX heading's marker and the space after it. */
const HEADING_START = /^ {0,3}#{1,6}[ \t]+/;

/** A fence line that opens or closes a fenced code block. */
const FENCE_START = /^ {0,3}(?:```|~~~)/;

/** A line indented enough to be an indented code block after a blank line. */
const INDENTED_CODE = /^(?: {4}|\t)/;

/** A thematic break: three or more of one marker, spaced or not. */
const THEMATIC_BREAK_START = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** A setext heading's underline: a run of equals, or one or two dashes, closing
 * the paragraph above it as a heading. Three or more of one marker is a
 * thematic break instead, whether it underlines the paragraph or breaks after
 * it, so the dash run here stops at two. */
const SETEXT_UNDERLINE_START = /^ {0,3}(?:=+|-{1,2})[ \t]*$/;

/** An HTML block's opening line: a tag, a comment, a processing instruction or
 * a declaration at the line's start. Inline content after a mark is not that,
 * because the raw line does not begin with the tag. */
const HTML_BLOCK_START = /^ {0,3}(?:<!--|<\?|<![A-Za-z]|<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>]|$))/;

/**
 * The HTML block `body` opens when it is a kind that CommonMark ends on a marker
 * of its own: `from`, where the raw text after the opener starts, and the
 * `terminator` that closes it. A comment, a processing instruction, a CDATA
 * section, a declaration and the raw-text elements (`script`, `pre`, `style`,
 * `textarea`) are those kinds; every other HTML block — a block tag, or a
 * complete tag alone — runs on to the next blank line and has no terminator.
 *
 * `undefined` for every line that opens none of them, including a line already
 * inside a raw-text element's own text.
 */
function htmlBlockTerminator(body: string): { from: number; terminator: string } | undefined {
  const indent = /^ {0,3}/.exec(body)?.[0].length ?? 0;
  const rest = body.slice(indent);
  const rawText = /^<(script|pre|style|textarea)\b/i.exec(rest);
  if (rawText !== null) {
    return { from: indent + rawText[0].length, terminator: `</${rawText[1] as string}>` };
  }
  if (rest.startsWith('<!--')) {
    return { from: indent + '<!--'.length, terminator: '-->' };
  }
  if (rest.startsWith('<?')) {
    return { from: indent + '<?'.length, terminator: '?>' };
  }
  if (rest.startsWith('<![CDATA[')) {
    return { from: indent + '<![CDATA['.length, terminator: ']]>' };
  }
  if (/^<![A-Za-z]/.test(rest)) {
    return { from: indent + '<!'.length, terminator: '>' };
  }
  return undefined;
}

/**
 * Whether `text` holds `terminator`, ignoring case: an HTML block's end marker
 * is syntax, never copy, and a raw-text element's end tag may be spelled in any
 * case. A case-insensitive pattern answers it without re-casing either string,
 * which this file may not do for text that could reach the screen.
 */
function holdsHtmlTerminator(text: string, terminator: string): boolean {
  const escaped = terminator.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(escaped, 'i').test(text);
}

/** A link reference definition: a label, a colon, and a destination. */
const REFERENCE_DEFINITION_START = /^ {0,3}\[[^\]\n]+\]:/;

/** Up to three spaces: an indentation a block's own content may still carry
 * after its marker, and the most a line may be indented and stay a paragraph. */
const CONTENT_INDENT = / {0,3}/y;

/** A task list item's checkbox and the space after it: `[ ]`, `[x]` or `[X]`. */
const TASK_CHECKBOX = /\[[ xX]\][ \t]+/y;

/** That checkbox at an offset's line start, matched non-sticky. */
const TASK_CHECKBOX_START = /^\[[ xX]\][ \t]/;

/** The run of backticks that opens an inline code span. */
const BACKTICK_RUN = /`+/y;

/** The inline openers a block's text may start with, each longer spelling
 * before the one it contains, so `**` is one opener and not two `*`. The
 * renderer parses GFM, so `~~` opens strikethrough as well. A link or image
 * opener, and a code span, are read apart: their labels and bodies are the
 * block's own text, not markup. */
const INLINE_OPENERS = ['**', '__', '~~', '*', '_'] as const;

/** A link or image opener, whose label's own text is the block's text. */
const LINK_OPENER = /!?\[/y;

/** The offset past the match of sticky `pattern` at `at`, or `at`. */
function pastMatch(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.exec(text) === null ? at : pattern.lastIndex;
}

/** The column reached at character `at` of `line`, each tab advancing to the next four-column stop. */
function columnAt(line: string, at: number): number {
  let column = 0;
  for (const character of line.slice(0, at)) {
    column = character === '\t' ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

/** The offset past the inline opener at `at`, or `at` when no opener is there. */
function pastOpener(text: string, at: number): number {
  const opener = INLINE_OPENERS.find(spelling => text.startsWith(spelling, at));
  if (opener !== undefined) {
    return at + opener.length;
  }
  // A link or image label, whose own text is the block's first text.
  return pastLinkOpener(text, at);
}

/**
 * The offset past the link or image opener at `at` — just past its opening
 * bracket, where the label's own text begins — when the label closes on an
 * inline destination; otherwise `at`.
 *
 * A reference label (`[label][definition]`, `[label]`, or a definition line
 * `[label]: url`) is looked up by a normalised key of its text, so dropping a
 * mark from that label would rename the key and change which destination
 * resolves: a reference label keeps its mark.
 */
function pastLinkOpener(text: string, at: number): number {
  const labelStart = pastMatch(LINK_OPENER, text, at);
  if (labelStart === at) {
    return at;
  }
  const close = text.indexOf(']', labelStart);
  const label = text.slice(labelStart, close);
  return close !== -1 && text[close + 1] === '(' && !/[[\n]/.test(label) ? labelStart : at;
}

/** `line` without the `[start, end)` ranges in `runs`, which do not overlap and
 * are in ascending order. */
function withoutRuns(line: string, runs: readonly (readonly [number, number])[]): string {
  let kept = '';
  let from = 0;
  for (const [start, end] of runs) {
    kept += line.slice(from, start);
    from = end;
  }
  return kept + line.slice(from);
}

/**
 * Whether `at` in `line` would open a block marker once the text before it is
 * removed, so that the line would parse as a different block than it does now.
 *
 * A mark can stand where a block marker would otherwise be: `  ‏# x` is a
 * paragraph because the mark interrupts the indentation, and removing the mark
 * would turn it into a heading, `- x` after it into a list item, `> x` into a
 * quote, or ```js into a fence. The strip must leave the document's blocks
 * alone, so a cut that would do that is refused. The same patterns the block
 * loop already trusts answer it, and the fence case is why it also keeps this
 * function's own fence bookkeeping honest: it reads the raw line, so a line the
 * renderer would draw as code must not be walked as prose here.
 *
 * A task checkbox counts only at `atItemStart`, a list item's own content
 * start: there `[ ] x` turns the item into a task item. In a paragraph's text
 * the same brackets are its own copy and open nothing.
 */
function opensBlockAt(line: string, at: number, atItemStart: boolean): boolean {
  const rest = line.slice(at);
  return (
    HEADING_START.test(rest) ||
    LIST_START.test(rest) ||
    BLOCKQUOTE_START.test(rest) ||
    FENCE_START.test(rest) ||
    THEMATIC_BREAK_START.test(rest) ||
    HTML_BLOCK_START.test(rest) ||
    REFERENCE_DEFINITION_START.test(rest) ||
    INDENTED_CODE.test(rest) ||
    (atItemStart && TASK_CHECKBOX_START.test(rest))
  );
}

/**
 * `line` from `at` — where the line's own content begins, past its blockquote
 * markers and its list or heading marker — with the direction marks in front of
 * the content's first character removed.
 *
 * The content may open on more machinery and markup before that character: up
 * to three spaces of indentation, a list item's task checkbox, then a run of
 * inline openers. A mark may sit in front of an opener (`- ‏**Latin**`) or
 * right after one (`- [‏Latin](url)`, where it is the link label's own first
 * character and still opens the block), so the walk reads one opening token at
 * a time and drops the mark runs in front of it. Once a token is not
 * recognised, the rest is the block's text, whose marks order the runs they
 * were written for and stay: markup this walk does not know (an HTML tag, say)
 * ends it there for the same reason. A reference link's label is the one shape
 * whose mark survives (`pastLinkOpener`).
 *
 * A cut is refused when it would open a block (see `opensBlockAt`), with two
 * exceptions. A checkbox refuses a cut only at the list item's own content
 * start, because that is where `[ ]` makes the item a task and nowhere else is
 * it structure. A cut just inside an opening code span is code and opens no
 * block, so it needs no check.
 */

function stripLineMarks(
  line: string,
  at: number,
  block: { listItem: boolean; inHeading: boolean }
): string {
  const runs: [number, number][] = [];
  /** Records the mark run at `from` only when cutting it keeps the same blocks. */
  const cut = (from: number, options?: { atItemStart?: boolean; insideCode?: boolean }): number => {
    const after = pastMatch(DIRECTION_MARK_RUN, line, from);
    // Inside a heading's own text no marker can start a block, so the mark there
    // is only an edge and always goes. Anywhere else a cut that would reparse
    // the line as a different block is refused, and the walk ends: only the
    // block's first character was the walk's business. Inside an opening code
    // span no marker can open a block either, and a checkbox is structure only
    // at the item's own content start.
    const atItemStart = block.listItem && options?.atItemStart === true;
    if (
      after === from ||
      (options?.insideCode !== true && !block.inHeading && opensBlockAt(line, after, atItemStart))
    ) {
      return from;
    }
    runs.push([from, after]);
    return after;
  };
  let cursor = cut(at, { atItemStart: true });
  // The block's machinery is kept exactly as written.
  cursor = cut(pastMatch(CONTENT_INDENT, line, cursor), { atItemStart: true });
  // A checkbox belongs to a list item's structure; without a list marker the
  // brackets and space are the paragraph's own text.
  const checkbox = block.listItem ? pastMatch(TASK_CHECKBOX, line, cursor) : cursor;
  if (checkbox > cursor) {
    cursor = cut(checkbox);
  }
  let opener = pastOpener(line, cursor);
  while (opener > cursor) {
    cursor = cut(opener);
    opener = pastOpener(line, cursor);
  }
  const span = pastMatch(BACKTICK_RUN, line, cursor);
  if (span > cursor) {
    cut(span, { insideCode: true });
  }
  // A mark just inside the opening backticks is still the block's first
  // character and went above; from the span's own text to the end of the line
  // nothing more is dropped, because that is code the content wrote and a mark
  // deeper inside it orders the code run it was written for.
  return withoutRuns(line, runs);
}

/**
 * `markdown` with the direction marks in front of each block's first character
 * removed, and every other character left as written.
 *
 * A block's own first letter names its direction, and both renderers resolve a
 * paragraph from its first strong character — which counts a direction mark as
 * strong. A bullet the content wrote as `- ‏Latin bullet` therefore laid its
 * item out right to left inside a left-to-right message: the mark decided
 * before the `L` was read, so the item sat on the wrong edge from the paragraph
 * above it (the design gate's markdown fallback block measured exactly that).
 * A mark in front of a block's first character names that block's edge and
 * nothing else, so removing it there leaves the block's own letter to decide;
 * a mark inside a block's text still orders the run it was written for.
 * Nothing is added: a block with no letter at all takes the message's direction
 * from the renderer's container.
 *
 * A block starts at the first line, after a blank line, after a line that closed
 * a block of its own — a heading, a thematic break or the setext underline
 * (a run of equals, or of one or two dashes) under a paragraph at the same quote
 * depth, a fence's closing line, a reference definition that starts a block,
 * an HTML block whose terminator arrived on its line, or code — and at a list,
 * blockquote or heading line's own content after its marker. A reference
 * definition cannot interrupt a paragraph, so a definition line inside one is
 * that paragraph's text and closes nothing. Its content may
 * open on further machinery and markup — indentation, a task checkbox, emphasis,
 * a link or image label — so the mark is found through all of it, in front of
 * the block's first real character rather than its marker. A continuation line
 * of a paragraph or of a list item keeps its marks.
 *
 * An HTML block of a terminator kind — a comment, a processing instruction, a
 * CDATA section, a declaration, or a raw-text element (`script`, `pre`, `style`,
 * `textarea`) — is raw text from its opening line to the line holding its
 * terminator, blank lines included. Those lines keep every mark they hold, and
 * nothing inside them is read as markdown; the line that holds the terminator
 * ends the block, so the line under it starts one. An HTML block of the tag
 * kinds still runs to the next blank line and keeps its marks.
 *
 * Fenced and indented code keep every character they hold. An inline code span
 * is the one place where the two rules meet: a mark as a span's first character
 * is also the block's first character, so it goes (as in `` `‏Latin code` ``),
 * while a mark deeper inside the span is part of the code written there and
 * stays. A reference link label keeps its mark, because a reference is looked
 * up by a key of its label's text.
 */
export function withoutLeadingDirectionMarks(markdown: string): string {
  if (!DIRECTION_MARK.test(markdown)) {
    return markdown;
  }
  const lines = markdown.split('\n');
  let changed = false;
  let previousBlank = true;
  // Whether the previous line closed a block of its own, so that this line opens
  // one and its content's mark is that block's edge.
  let previousEndsBlock = false;
  // The quote depth of the paragraph text directly above, when a setext
  // underline at the same depth would close it: how the walk tells a paragraph
  // that follows a heading-shaped line from one the line above continues. The
  // depth is the number of `>` markers, not the prefix's width, because `> Title`
  // and `>===` sit in the same quote though their prefixes differ by a character.
  let previousParagraphDepth: number | undefined = undefined;
  // Whether the previous line held an indented code block, which the lines under
  // it continue while they keep the indentation.
  let inIndentedCode = false;
  let inFence = false;
  // The terminator that closes the HTML block now open, when the previous line
  // opened one of the kinds CommonMark ends on a marker of its own. Every line
  // until that marker is the block's raw text, blank lines included.
  let openHtmlBlock: string | undefined = undefined;
  for (const [index, line] of lines.entries()) {
    const quoted = BLOCKQUOTE_START.exec(line)?.[0].length ?? 0;
    const quotedDepth = (line.slice(0, quoted).match(/>/g) ?? []).length;
    const body = line.slice(quoted);
    const blank = body.trim().length === 0;
    // A line inside an HTML block of a terminator kind is that block's raw text:
    // it keeps every mark it holds and none of it is read as markdown. A line
    // outside one may open that kind, and then it is raw text too.
    const rawHtml: boolean = openHtmlBlock !== undefined;
    const opensFence = !rawHtml && FENCE_START.test(body);
    // An indented code block starts after a blank line or after a block that has
    // closed, and runs on while the lines keep its indentation; an indented line
    // under paragraph text is that paragraph's own continuation instead. These
    // three predicates feed each other through the walk's state, which the
    // checker cannot infer a type for, so each says it is a boolean.
    const indentedCode: boolean =
      !rawHtml &&
      !inFence &&
      INDENTED_CODE.test(body) &&
      !blank &&
      (previousBlank || previousEndsBlock || inIndentedCode);
    // Code is copy in its own right: a mark inside it is part of the code.
    const code: boolean = inFence || indentedCode;
    // A fence's own lines are code, so an HTML block may not start inside one.
    const html: { from: number; terminator: string } | undefined =
      rawHtml || code ? undefined : htmlBlockTerminator(body);
    // The block ends on the line that holds its terminator, or, for a block that
    // opens and closes on one line, on that line: the line under it opens a
    // block. A raw-text element's end tag is matched without regard to case,
    // while every other terminator holds no letter, so one comparison serves all.
    const closesHtml: boolean =
      openHtmlBlock !== undefined
        ? holdsHtmlTerminator(line, openHtmlBlock)
        : html !== undefined && holdsHtmlTerminator(line.slice(html.from), html.terminator);
    // A line that is an HTML block's raw text — the block's opening line, or a
    // line inside one — is not read as markdown: a `#` or a run of dashes inside
    // a `<pre>` is that block's copy, not a heading or an underline.
    const htmlLine: boolean = html !== undefined || rawHtml;
    // A list item or heading's own marker is line machinery its content follows;
    // a continuation line has none and keeps its marks. A heading may sit inside
    // a list item (`- # x`), so its marker is read after the list marker too —
    // but only within the item's content indent. Under CommonMark a marker
    // followed by five or more spaces pads to one space and the rest is code, so
    // `-     # x` is an indented code block whose text must keep every character.
    const list: RegExpExecArray | null = htmlLine ? null : LIST_START.exec(body);
    let contentStart = 0;
    if (list !== null) {
      // `LIST_START` is greedy over the padding, so the marker's own width is
      // read apart from it. CommonMark expands a tab to the next four-column tab
      // stop before it decides this, so the padding is measured in columns, not
      // in characters: `-\t\t# x` pads seven columns and holds code, where two
      // characters would look like an item's own indent. The columns are the
      // line's own, because that is where the tab stops sit: the marker's column
      // is read from the line with tabs expanded, since a tab in the quote
      // prefix does not advance one column per character.
      const markerEnd = /^ {0,3}(?:[-*+]|\d{1,9}[.)])/.exec(body)?.[0].length ?? 0;
      const markerColumn = columnAt(line, quoted + markerEnd);
      const afterMarker = body.slice(markerEnd);
      const run = /^[ \t]*/.exec(afterMarker)?.[0] ?? '';
      let column = markerColumn;
      let padding = 0;
      for (const character of run) {
        const next = character === '\t' ? column + 4 - (column % 4) : column + 1;
        padding = next - markerColumn;
        column = next;
      }
      // Five or more columns pad to one, leaving an indented code block: its text
      // is code and the heading rule must not reach into it.
      contentStart = padding >= 5 ? body.length : markerEnd + run.length;
    }
    const heading: RegExpExecArray | null = htmlLine
      ? null
      : HEADING_START.exec(body.slice(contentStart));
    const marker: number = contentStart + (heading?.[0].length ?? 0);
    // Whether this line opens a block: the first line, a line under a blank or
    // after a line that closed a block, and a list, quote or heading line's own
    // content after its marker.
    const startsBlock: boolean = previousBlank || previousEndsBlock || marker > 0;
    // A line that closes a block of its own leaves the line after it opening
    // one: an ATX heading, a thematic break or the setext underline under the
    // paragraph above, a reference definition that starts a block, an HTML block
    // whose terminator arrived on its line, and code — the fence's last line
    // before the closing fence, the fence line that closed it, and an indented
    // code line, whose block ends at the first line not indented far enough for
    // the walk to read it as code.
    //
    // A definition only ends a block when the line carrying it starts one: it
    // cannot interrupt a paragraph, so inside one it is the paragraph's own
    // text and the line under it continues that paragraph.
    const endsBlock: boolean = htmlLine
      ? closesHtml
      : code ||
        heading !== null ||
        THEMATIC_BREAK_START.test(body) ||
        (previousParagraphDepth === quotedDepth && SETEXT_UNDERLINE_START.test(body)) ||
        (startsBlock && REFERENCE_DEFINITION_START.test(body));
    const stripped =
      opensFence || htmlLine || code || blank || !startsBlock
        ? line
        : stripLineMarks(line, quoted + marker, {
            listItem: list !== null,
            inHeading: heading !== null,
          });
    if (opensFence) {
      inFence = !inFence;
    }
    // The block's terminator closes it, and the line that held it leaves the
    // line after it opening a block; a block still open runs on.
    if (closesHtml) {
      openHtmlBlock = undefined;
    } else if (html !== undefined) {
      openHtmlBlock = html.terminator;
    }
    previousBlank = blank;
    previousEndsBlock = endsBlock;
    inIndentedCode = indentedCode;
    // Only paragraph text in this line's own container can be closed by the next
    // line's setext underline, and a list item's opening text is such paragraph
    // text: the underline closes it and the line under the underline is an item
    // paragraph of its own. Without the underline that line is the item's lazy
    // continuation instead, which the depth comparison alone cannot tell apart —
    // so a markerless line under an item keeps its mark through the setext rule,
    // not through this one. An HTML line is raw, not paragraph text, so it says
    // nothing to the next.
    previousParagraphDepth = blank || code || endsBlock || htmlLine ? undefined : quotedDepth;
    if (stripped !== line) {
      lines[index] = stripped;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : markdown;
}

/**
 * A right-to-left mark (U+200F): a strong character with no width, so it names
 * a paragraph's start edge for the bidi algorithm without drawing or speaking
 * anything.
 */
const RIGHT_TO_LEFT_MARK = '\u200F';

/**
 * Whether a caller's own style names a base direction, through `direction` or
 * `writingDirection`. A caller that names one has said what the paragraph's
 * direction is: a value that names a path, a command or an identifier pins left
 * to right (`LTR_TEXT_DIRECTION`), and appending a right-to-left mark would lay
 * that value out in an order its reader did not ask for.
 *
 * Only a value that names a direction counts. `direction: 'inherit'` leaves the
 * direction to the parent's layout and `writingDirection: 'auto'` resolves it
 * from the first strong character — the default this mark exists to override
 * on Android — so neither is a caller's choice of base direction.
 *
 * The style is flattened so the test sees the same single object React Native
 * draws, and an array of style entries, an inline object and a registered sheet
 * entry all reach their properties.
 */
export function pinsTextDirection(style: StyleProp<TextStyle> | undefined): boolean {
  if (style === undefined) {
    return false;
  }
  const flat: TextStyle | null | undefined = StyleSheet.flatten(style);
  if (!flat) {
    return false;
  }
  return (
    flat.direction === 'ltr' ||
    flat.direction === 'rtl' ||
    flat.writingDirection === 'ltr' ||
    flat.writingDirection === 'rtl'
  );
}

/**
 * `children` with a right-to-left mark in front when an app label has to lay
 * out right to left for the interface's sake, not its own first strong
 * character's.
 * Android resolves a paragraph's direction from its first strong character, and
 * React Native never sets a text view's own direction, so a label that opens on
 * a Latin product name inside a right-to-left interface otherwise lays out left
 * to right and its Arabic half lands at the far end. The mark names the
 * interface's start edge for the paragraph, and the label's own words keep
 * their own direction after it.
 *
 * The mark applies only when the interface is right to left, `holdsRtlScript`
 * is true — the tree holds an Arabic or Hebrew letter (`hasRtlScript`) — and
 * the tree's first letter is not a right-to-left one (`directionOfStrong`).
 * Copy that already opens right to left needs no mark, and Latin-only copy such
 * as `Sentry.` keeps its own base direction, so its full stop stays at the end
 * of the word.
 *
 * The caller passes the script flag it already computed, so this helper reads
 * one letter instead of scanning the whole tree again: `firstStrong` stops at
 * the first one.
 *
 * A string child takes the mark in front of it, in one run. Any other node gets
 * the mark as its first sibling, in a fragment: the child keeps its own
 * identity, so a lone element child is not re-wrapped and React logs no
 * missing-key warning.
 */
export function rtlBaseMarkedChildren(children: ReactNode, holdsRtlScript: boolean): ReactNode {
  if (!I18nManager.isRTL || !holdsRtlScript) {
    return children;
  }
  const strong = firstStrong(children);
  if (strong === undefined || directionOfStrong(strong) === 'rtl') {
    return children;
  }
  if (isStringChild(children)) {
    return RIGHT_TO_LEFT_MARK + children;
  }
  return createElement(Fragment, null, RIGHT_TO_LEFT_MARK, children);
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
