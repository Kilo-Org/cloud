import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';

/**
 * Resolve a markdown fence info string to the language name used by the
 * highlighter, or `null` for no language. Only the first word counts
 * (`'TS extra'` → `'ts'`); alias resolution is left to lowlight, and unknown
 * names fall back to plain text inside `highlightLine`. `undefined`, empty,
 * and whitespace-only info strings all return `null`.
 */
export function normalizeFenceLanguage(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const first = raw.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/**
 * Source lines per non-selectable `RNText`.
 *
 * A code fence's Android cost has two shapes, and they pull in opposite
 * directions: a `Text` is one native `ReactTextView` (a view, a yoga node, and
 * a measure/draw pass), and `SetSpanOperation.execute` runs once per span
 * packed into one `Text` — RN applies the span operations of a whole
 * `SpannableStringBuilder` in one frame, and the insertion cost of that
 * builder grows with the spans it already holds. One `Text` for the whole
 * fence gives all of its spans to a single view; one `Text` per source line
 * gives the fence one native view per line (a 1,300-line read tool card became
 * 1,300 views). A chunk bounds both: every `Text` holds at most this many
 * lines of spans, and a fence needs one view per chunk.
 *
 * A selectable fence cannot be chunked at all: Android selects inside one
 * `ReactTextView`, so splitting it would let the user select one chunk per
 * gesture (see `code-block.tsx`).
 */
const CODE_CHUNK_LINES = 32;

/**
 * Group highlighted lines into render chunks of at most `CODE_CHUNK_LINES`
 * lines. The last chunk holds the remainder.
 */
export function chunkTokenLines(lines: readonly HighlightToken[][]): HighlightToken[][][] {
  const chunks: HighlightToken[][][] = [];
  for (let start = 0; start < lines.length; start += CODE_CHUNK_LINES) {
    chunks.push(lines.slice(start, start + CODE_CHUNK_LINES));
  }
  return chunks;
}

/**
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}
