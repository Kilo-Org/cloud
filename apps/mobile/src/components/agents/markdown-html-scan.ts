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

const FENCE_OPEN = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t| {1,3}\t)/;
const BLANK_LINE = /^[ \t]*$/;

function blockCodeRanges(value: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  let fence: { marker: string; start: number } | null = null;
  let previousBlank = true;
  let inIndented = false;
  let lineStart = 0;
  while (lineStart <= value.length) {
    const newline = value.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? value.length : newline;
    const line = value.slice(lineStart, lineEnd);
    const blank = BLANK_LINE.test(line);
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      const marker = close?.[1];
      if (marker?.startsWith(fence.marker[0] ?? '') && marker.length >= fence.marker.length) {
        ranges.push({ start: fence.start, end: lineEnd, block: true });
        fence = null;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      const marker = open?.[1];
      if (marker && !(marker.startsWith('`') && open[2]?.includes('`'))) {
        fence = { marker, start: lineStart };
        inIndented = false;
      } else if (!blank && (previousBlank || inIndented) && INDENTED_CODE.test(line)) {
        ranges.push({ start: lineStart, end: lineEnd, block: true });
        inIndented = true;
      } else if (!blank) {
        inIndented = false;
      }
    }
    previousBlank = blank;
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
const BACKTICK_RUN = /`+/y;

/** The end of the inline run that holds `from`: a blank line, a code block, or the value end. */
function inlineRunEnd(value: string, from: number, nextBlock: MaskRange | undefined): number {
  PARAGRAPH_BREAK.lastIndex = from;
  const blank = PARAGRAPH_BREAK.exec(value)?.index ?? value.length;
  return Math.min(blank, nextBlock?.start ?? value.length);
}

/**
 * The code span opening at `start`, a run of backticks: it closes at the next
 * run of the same length in its inline run. An unclosed one in the last inline
 * run is still streaming, so it runs to the end; elsewhere it is literal text.
 */
function codeSpanAt(value: string, start: number, nextBlock: MaskRange | undefined) {
  BACKTICK_RUN.lastIndex = start;
  const length = BACKTICK_RUN.exec(value)?.[0].length ?? 1;
  const limit = inlineRunEnd(value, start, nextBlock);
  const closing = new RegExp(`(?<!\`)\`{${length}}(?!\`)`).exec(value.slice(start + length, limit));
  if (closing) {
    return { range: { start, end: start + length + closing.index + length }, length };
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
  const ranges: MaskRange[] = [];
  let blockIndex = 0;
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
      const span = codeSpanAt(value, index, block);
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
