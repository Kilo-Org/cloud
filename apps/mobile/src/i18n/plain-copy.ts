import { isolateLtrBidiText } from '@/lib/bidi';

/**
 * One backticked inline-code run. A lone backtick (an authoring slip) matches
 * the empty alternative so the marker still never reaches the reader.
 */
const INLINE_CODE = /`([^`]*)`|`/g;

/** One run of a catalog string: prose, or a marked command or path. */
export type InlineCodeSegment = Readonly<{ text: string; code: boolean }>;

/**
 * Splits catalog copy into prose and marked runs, so a renderer can draw each
 * run in the mono style while the sentence around it keeps the body style.
 * Untouched prose stays byte-for-byte, which keeps a sentence that wraps across
 * the run identical to the catalog value.
 *
 * A marked run is a command or a path, so it renders as one isolated
 * left-to-right run (`isolateLtrBidiText`). In a right-to-left paragraph the
 * run then keeps its own order instead of taking the sentence's, and the
 * punctuation outside the isolate still belongs to the sentence: `kilo
 * remote`. keeps its period at the sentence end.
 *
 * The run's own spaces become no-break spaces, the treatment the credit-expiry
 * note gives its zone marker: a breakable space let a wrapped sentence split
 * the command, which then read as two fragments with the period on the wrong
 * side. The isolate leaves the rest of the sentence free to wrap.
 */
export function splitInlineCode(value: string): readonly InlineCodeSegment[] {
  const segments: InlineCodeSegment[] = [];
  let cursor = 0;
  const pushProse = (text: string) => {
    if (text.length === 0) {
      return;
    }
    const previous = segments.at(-1);
    // A lone marker (an authoring slip) leaves prose on both sides of nothing:
    // the reader must not see the sentence split where the marker sat.
    if (previous !== undefined && !previous.code) {
      segments[segments.length - 1] = { code: false, text: previous.text + text };
      return;
    }
    segments.push({ code: false, text });
  };
  for (const match of value.matchAll(INLINE_CODE)) {
    const at = match.index;
    if (at > cursor) {
      pushProse(value.slice(cursor, at));
    }
    const run = match[1];
    if (run !== undefined) {
      segments.push({ code: true, text: isolateLtrBidiText(run.replaceAll(' ', '\u00A0')) });
    }
    cursor = at + match[0].length;
  }
  if (cursor < value.length) {
    pushProse(value.slice(cursor));
  }
  return segments;
}

/**
 * Plain copy for a native `Text` that cannot draw a nested run, such as an
 * accessibility label. The catalogs mark commands and paths with backticks;
 * this drops the markup and keeps the run's bidi treatment.
 */
export function stripInlineCodeMarkers(value: string): string {
  return splitInlineCode(value)
    .map(segment => segment.text)
    .join('');
}
