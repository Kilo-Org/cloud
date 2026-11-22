import { blockLines, MARKDOWN_BLOCK_TAGS } from './markdown-html-block';
import { type ConvertContext, inlineContent } from './markdown-html-inline';
import { type HtmlElement, scanMarkdownCode } from './markdown-html-scan';
import { parseMarkdownHtml } from './markdown-html-tree';

const LINE_END = /[ \t]*(?:\n|$)/y;
// A line a `<br>` cannot continue: a heading, a quote, a list item, a table
// row, or indented code. The paragraph-only hard break would change its block.
// Whitespace here is matched without the newline that ends the line, so the
// pattern reads the same on the whole value as on the one line.
const BREAK_BLOCKED_LINE = /(?: {4}|\t|[^\S\n]*(?:#|>|[-+*][^\S\n]|\d{1,9}[.)][^\S\n]))/y;
// A line that ends the paragraph before it, so a break before it draws nothing.
const PARAGRAPH_ENDING_LINE =
  /(?:[ \t]*(?:\n|$)| {0,3}(?:#{1,6}(?:\s|$)|>|[-+*][ \t]|\d{1,9}[.)][ \t]|`{3}|~{3}|<|[=-]+[ \t]*(?:\n|$)|(?:[*_][ \t]*){3,}(?:\n|$)))/y;
const WHITESPACE = /\s/;

/** The line of a root `<br>`: where it begins and ends, and whether a break can continue it. */
type LineInfo = {
  start: number;
  end: number;
  blocked: boolean;
  // The last non-whitespace character before the first break on the line, or
  // that break's start when the text before it is blank. A later break on the
  // line has the tag of an earlier one before it, so it has text before it too.
  firstNonSpace: number;
  // A tag with a newline of its own makes the line it reads run past that
  // newline, so only a tag that stays on one line gives bounds to share.
  reusable: boolean;
};

/** Root nodes arrive in document order, so the line of one break often holds the next. */
type LineCache = { line: LineInfo | null };

/** Reads the line around a break, and whether a break there would change its block. */
function analyseLine(value: string, element: HtmlElement): LineInfo {
  const start = value.lastIndexOf('\n', element.start - 1) + 1;
  const newline = value.indexOf('\n', element.end);
  const end = newline === -1 ? value.length : newline;
  BREAK_BLOCKED_LINE.lastIndex = start;
  // The pipe is searched inside this line only: a search from `start` runs to
  // the end of the whole value even when the answer lies on another line, and
  // one such scan per line would cost the message length per break line.
  let pipe = false;
  for (let at = start; at < end; at += 1) {
    if (value[at] === '|') {
      pipe = true;
      break;
    }
  }
  const blocked = BREAK_BLOCKED_LINE.test(value) || pipe;
  let at = element.start - 1;
  while (at >= start) {
    const character = value[at];
    if (character === undefined || !WHITESPACE.test(character)) {
      break;
    }
    at -= 1;
  }
  return {
    start,
    end,
    blocked,
    firstNonSpace: at >= start ? at : element.start,
    reusable: value.lastIndexOf('\n', element.end - 1) < element.start,
  };
}

/**
 * A root `<br>` as markdown: a backslash break that continues the paragraph,
 * nothing where the paragraph ends anyway, or null on a line a break would
 * change. `skip` is the source after the tag the break already accounts for.
 */
function rootBreak(
  value: string,
  element: HtmlElement,
  cache: LineCache
): { text: string; skip: number } | null {
  let line = cache.line;
  if (line === null || element.start < line.start || element.end > line.end) {
    line = analyseLine(value, element);
    cache.line = line.reusable ? line : null;
  }
  if (line.firstNonSpace >= element.start || line.blocked) {
    return null;
  }
  let at = element.end;
  while (value[at] === ' ' || value[at] === '\t') {
    at += 1;
  }
  let broke = false;
  if (value[at] === '\n') {
    broke = true;
    at += 1;
    while (value[at] === ' ' || value[at] === '\t') {
      at += 1;
    }
  }
  if (at >= value.length) {
    return { text: '', skip: 0 };
  }
  if (broke) {
    PARAGRAPH_ENDING_LINE.lastIndex = at;
    if (PARAGRAPH_ENDING_LINE.test(value)) {
      return { text: '', skip: 0 };
    }
  }
  return { text: '\\\n', skip: at - element.end };
}

/**
 * A root block element as markdown lines. It must own its lines, starting at
 * a line start and ending at a line end (or, closed implicitly by the next
 * line's tag, just after one): a block inside a list item or after text on the
 * same line stays HTML.
 */
function rootBlock(context: ConvertContext, element: HtmlElement): string[] | null {
  const { value } = context;
  LINE_END.lastIndex = element.end;
  const ownsLines =
    (element.start === 0 || value[element.start - 1] === '\n') &&
    (value[element.end - 1] === '\n' || LINE_END.test(value));
  return ownsLines ? blockLines(context, element) : null;
}

/**
 * Rewrites the HTML in a markdown value that markdown can express exactly —
 * emphasis, strikethrough, code, links, HTTPS images, line breaks, paragraphs,
 * headings, lists, quotes, code blocks, rules, and plain tables — so it renders
 * natively, through the same image gate and link confirmation as markdown.
 *
 * Everything else is copied verbatim: code (fences, indented code, code spans),
 * comments, tags markdown cannot express, any element with a meaningful
 * attribute or an unconvertible descendant, and malformed markup. An element
 * still streaming in converts as if it closed at the end of the value, so the
 * markdown only grows as the message does.
 */
export function convertHtmlToMarkdown(value: string): string {
  if (!value.includes('<')) {
    return value;
  }
  const context: ConvertContext = { value, masks: scanMarkdownCode(value) };
  const nodes = parseMarkdownHtml(value, context.masks);
  if (!nodes.some(node => node.kind === 'element')) {
    return value;
  }
  // The output and its last two characters. Reading a character back from the
  // output copies it, so a value with many root nodes would copy the whole
  // converted message once per node; the tail answers those reads instead.
  const out: ConvertedOutput = { text: '', tail: '' };
  let skip = 0;
  const cache: LineCache = { line: null };
  for (const node of nodes) {
    const skipped = skip;
    skip = 0;
    if (node.kind === 'text') {
      appendOutput(
        out,
        value.slice(node.start + Math.min(skipped, node.end - node.start), node.end)
      );
    } else if (node.name === 'br') {
      const lineBreak = rootBreak(value, node, cache);
      appendOutput(out, lineBreak?.text ?? value.slice(node.start, node.end));
      skip = lineBreak?.skip ?? 0;
    } else if (MARKDOWN_BLOCK_TAGS.has(node.name)) {
      const lines = rootBlock(context, node);
      if (lines === null) {
        appendOutput(out, value.slice(node.start, node.end));
      } else {
        appendBlock(out, lines, node.end < value.length);
      }
    } else {
      const inline = inlineContent(context, [node], {
        allowBreak: false,
        inLink: false,
        before: out.tail.at(-1),
        after: value[node.end],
      });
      appendOutput(out, inline ?? value.slice(node.start, node.end));
    }
  }
  return out.text;
}

/** The converted output and the tail that stands in for reading its last characters. */
type ConvertedOutput = { text: string; tail: string };

function appendOutput(out: ConvertedOutput, part: string): void {
  if (part === '') {
    return;
  }
  out.text += part;
  out.tail = part.length >= 2 ? part.slice(-2) : `${out.tail}${part}`.slice(-2);
}

/**
 * A converted block is its own markdown block: blank lines on both sides keep
 * it from joining the paragraph or list around it.
 */
function appendBlock(out: ConvertedOutput, lines: readonly string[], more: boolean): void {
  if (out.text !== '' && out.tail !== '\n\n') {
    appendOutput(out, out.tail.endsWith('\n') ? '\n' : '\n\n');
  }
  appendOutput(out, lines.join('\n'));
  if (more) {
    appendOutput(out, '\n');
  }
}
