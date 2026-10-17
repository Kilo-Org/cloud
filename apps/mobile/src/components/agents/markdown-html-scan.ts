/**
 * Reads the HTML tags of a markdown value into a small element tree, skipping
 * every region markdown treats as code: fenced and indented code blocks, code
 * spans, and HTML comments. `markdown-html-convert` turns the elements it can
 * express in markdown into markdown and copies every other byte verbatim.
 */

/**
 * A protected source range `[start, end)`. `block` marks fenced or indented
 * code; `unclosed` marks a code span with no closing run yet, which runs to the
 * end of the value.
 */
export type MaskRange = { start: number; end: number; block?: true; unclosed?: true };

type HtmlText = { kind: 'text'; start: number; end: number };

export type HtmlElement = {
  kind: 'element';
  name: string;
  attributes: Map<string, string>;
  /** Offset of `<` in the open tag. */
  start: number;
  /** Offset just past the open tag. */
  contentStart: number;
  /** Offset of the close tag, or of the point the element was closed implicitly. */
  contentEnd: number;
  /** Offset just past the close tag (equal to `contentEnd` without one). */
  end: number;
  children: HtmlNode[];
  /** Closed by a tag that skipped over it (`<b><i>x</b>`): its markup is not trustworthy. */
  malformed: boolean;
  /** Holds a fenced or indented code block, which markdown cannot nest in its output. */
  containsBlockCode: boolean;
};

export type HtmlNode = HtmlElement | HtmlText;

const FENCE_OPEN = /^(?:[ \t]*>)*([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(?:[ \t]*>)*([ \t]*)(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t| {1,3}\t)/;
const BLANK_LINE = /^[ \t]*$/;
/** An ATX heading or a thematic break: a line that ends any paragraph. */
const HEADING_OR_BREAK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/;
/** A setext underline: a run of one character, which ends only a paragraph above it. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/** The indent width of leading spaces and tabs, a tab advancing to the next multiple of four. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) {
    width = char === '\t' ? width + 4 - (width % 4) : width + 1;
  }
  return width;
}

function blockCodeRanges(value: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  let fence: { marker: string; start: number; indent: number } | null = null;
  // Whether an indented line here starts code: after a blank line, a closed
  // fence, a heading, a thematic break, or a setext underline. Inside a
  // paragraph it continues the paragraph instead.
  let codeCanStart = true;
  let inIndented = false;
  let inParagraph = false;
  let lineStart = 0;
  while (lineStart <= value.length) {
    const newline = value.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? value.length : newline;
    const line = value.slice(lineStart, lineEnd);
    const blank = BLANK_LINE.test(line);
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      const marker = close?.[2];
      // A closing fence may sit at most three columns deeper than its opener
      // (the opener's indent is the list item's content column inside a list);
      // deeper, it is fence content.
      if (
        marker?.startsWith(fence.marker[0] ?? '') &&
        marker.length >= fence.marker.length &&
        indentWidth(close?.[1] ?? '') <= fence.indent + 3
      ) {
        ranges.push({ start: fence.start, end: lineEnd, block: true });
        fence = null;
        codeCanStart = true;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      const marker = open?.[2];
      let paragraphLine = false;
      if (marker && !(marker.startsWith('`') && open[3]?.includes('`'))) {
        fence = { marker, start: lineStart, indent: indentWidth(open[1] ?? '') };
        inIndented = false;
      } else if (!blank && (codeCanStart || inIndented) && INDENTED_CODE.test(line)) {
        ranges.push({ start: lineStart, end: lineEnd, block: true });
        inIndented = true;
      } else if (!blank) {
        inIndented = false;
        paragraphLine = true;
      }
      const endsParagraph: boolean =
        HEADING_OR_BREAK.test(line) || (inParagraph && SETEXT_UNDERLINE.test(line));
      codeCanStart = blank || endsParagraph;
      inParagraph = paragraphLine && !endsParagraph;
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  if (fence) {
    // An unclosed fence runs to the end of the value, as it does in markdown.
    ranges.push({ start: fence.start, end: value.length, block: true });
  }
  return ranges;
}

const PARAGRAPH_BREAK = /\n[ \t]*(?:\n|$)/g;

/** The start of every blank-line separator in `value`, in order. */
function paragraphBreaks(value: string): number[] {
  const breaks: number[] = [];
  for (const match of value.matchAll(PARAGRAPH_BREAK)) {
    breaks.push(match.index);
  }
  return breaks;
}

/**
 * Code spans one scan looks for before it stops. Past the budget the rest of the
 * value is copied verbatim, so the number of spans a render assembles is bounded
 * and the HTML in the rest renders through the HTML engine.
 */
const MAX_CODE_SPANS = 4096;

/**
 * The code span opening at `start`, a run of backticks: it closes at the next
 * run of the same length in its inline run, the part of the value before
 * `limit`. An unclosed one in the last inline run is still streaming, so it runs
 * to the end; elsewhere it is literal text.
 */
function codeSpanAt(value: string, start: number, limit: number) {
  let length = 0;
  while (value[start + length] === '`') {
    length += 1;
  }
  // Runs of any other length are skipped whole, so the walk visits each run of
  // the inline run at most once.
  for (let at = value.indexOf('`', start + length); at !== -1 && at < limit; ) {
    let run = 1;
    while (value[at + run] === '`') {
      run += 1;
    }
    if (run === length) {
      return { range: { start, end: at + length }, length };
    }
    at = value.indexOf('`', at + run);
  }
  const range: MaskRange | null =
    limit === value.length ? { start, end: value.length, unclosed: true } : null;
  return { range, length };
}

/**
 * Every range of `value` the converter must copy verbatim, sorted by start.
 * An unclosed code span in the last inline run extends to the end: a streamed
 * message that has not closed its span yet must not convert HTML inside it.
 */
export function scanMarkdownCode(value: string): MaskRange[] {
  const blocks = blockCodeRanges(value);
  const breaks = paragraphBreaks(value);
  const ranges: MaskRange[] = [];
  let blockIndex = 0;
  let breakIndex = 0;
  let spans = 0;
  let index = 0;
  while (index < value.length) {
    const block = blocks[blockIndex];
    const char = value[index];
    if (block && index >= block.start) {
      ranges.push(block);
      index = Math.max(index, block.end);
      blockIndex += 1;
    } else if (char === '\\') {
      index += 2;
    } else if (char === '<' && value.startsWith('<!--', index)) {
      const close = value.indexOf('-->', index + 4);
      const end = close === -1 ? value.length : close + 3;
      ranges.push({ start: index, end });
      index = end;
      while ((blocks[blockIndex]?.start ?? Infinity) < index) {
        blockIndex += 1;
      }
    } else if (char === '`') {
      if (spans === MAX_CODE_SPANS) {
        // The rest is copied verbatim: no further code span is looked for, and
        // the HTML it holds renders through the HTML engine like any other HTML
        // markdown cannot express.
        ranges.push({ start: index, end: value.length });
        break;
      }
      spans += 1;
      // The span closes within its inline run: the first blank line at or after
      // it, or the next code block, whichever comes first. Both cursors only
      // move forward, so the whole scan walks each of them once.
      while (breakIndex < breaks.length && (breaks[breakIndex] ?? 0) < index) {
        breakIndex += 1;
      }
      const limit = Math.min(breaks[breakIndex] ?? value.length, block?.start ?? value.length);
      const span = codeSpanAt(value, index, limit);
      if (span.range) {
        ranges.push(span.range);
      }
      index = span.range?.end ?? index + span.length;
    } else {
      index += 1;
    }
  }
  return ranges;
}
