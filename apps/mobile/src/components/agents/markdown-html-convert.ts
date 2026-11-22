import { blockLines, MARKDOWN_BLOCK_TAGS } from './markdown-html-block';
import { type ConvertContext, inlineContent } from './markdown-html-inline';
import {
  type HtmlElement,
  type HtmlNode,
  type MaskRange,
  scanMarkdownCode,
} from './markdown-html-scan';
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
// A tag still streaming in at the end of a value, whose close is not written
// yet, so the conversion of the text before it can still change.
const PARTIAL_TAG_AT_END = /<\/?[a-zA-Z][^<>]*$/;

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
  // Plain text converts to itself; skip the scan and the tail it would report.
  if (!value.includes('<')) {
    return value;
  }
  return convertHtmlToMarkdownWithTail(value).markdown;
}

/**
 * The conversion of a value plus the offset at which that conversion is not
 * yet final.
 */
export type ConvertedMarkdown = {
  markdown: string;
  /**
   * Source offset where the still-open region begins: the start of the open
   * line, walked back over every code mask and root element that crosses it.
   * 0 means no reuse (nothing is final). Equal to `value.length` means the
   * whole conversion is final.
   */
  tailStart: number;
};

/**
 * `convertHtmlToMarkdown` plus the offset where its conversion stops being
 * final, from the same masks and root nodes the conversion itself reads.
 *
 * Everything before `tailStart` converts the same whatever follows it: the
 * region begins at the start of the open line, backed up to the start of every
 * construct that crosses that line start, so no fence, code span, comment, or
 * element straddles the seam. A caller that streams a value can then convert
 * only `value.slice(tailStart)` on the next publish.
 */
export function convertHtmlToMarkdownWithTail(value: string): ConvertedMarkdown {
  // Plain text converts to itself, so its tail is its open line — unless it
  // holds a fence or code-span marker, which makes a construct that reaches the
  // end of the value and can swallow what the next publish appends, or ends
  // after a backslash, which escapes the character the next publish adds.
  if (!value.includes('<') && !value.includes('`') && !value.includes('~~~')) {
    return {
      markdown: value,
      tailStart: endsInsideOpenConstruct(value) ? 0 : value.lastIndexOf('\n') + 1,
    };
  }
  const masks = scanMarkdownCode(value);
  const nodes = parseMarkdownHtml(value, masks);
  const tailStart = openTailStart(value, masks, nodes);
  if (!nodes.some(node => node.kind === 'element')) {
    return { markdown: value, tailStart };
  }
  return { markdown: renderMarkdown(value, masks, nodes), tailStart };
}

/**
 * Where the conversion of `value` stops being final: the start of its open
 * line, walked back to the start of each code range and root element that
 * crosses it, until no construct crosses the boundary. 0 when the open region
 * ends inside a tag or after a backslash, whose next character can rewrite the
 * text before it.
 *
 * A construct that is still open at the end of the value crosses a boundary
 * there even though its own bounds end just before it: a fence runs to the end
 * of the value, and an element the parse closed implicitly at its last prose
 * keeps absorbing the next line, since only a blank line closes an inline tag.
 */
function openTailStart(
  value: string,
  masks: readonly MaskRange[],
  nodes: readonly HtmlNode[]
): number {
  let lastProse = value.length;
  while (lastProse > 0 && WHITESPACE.test(value[lastProse - 1] ?? '')) {
    lastProse -= 1;
  }
  // An element closed implicitly at the last prose character is still open: the
  // next publish extends it, and a blank line would be what closes it instead.
  const openAtEnd = (node: HtmlElement) => node.contentEnd === node.end && node.end >= lastProse;
  let boundary = value.lastIndexOf('\n') + 1;
  // Backing up moves the boundary to a construct's start, which an earlier
  // construct can cross in turn, so walk until nothing crosses it.
  for (;;) {
    let start = boundary;
    for (const mask of masks) {
      if (mask.start < boundary && (mask.end > boundary || mask.end === value.length)) {
        start = Math.min(start, mask.start);
      }
    }
    for (const node of nodes) {
      if (
        node.kind === 'element' &&
        node.start < boundary &&
        (node.end > boundary || openAtEnd(node))
      ) {
        start = Math.min(start, node.start);
      }
    }
    if (start === boundary) {
      break;
    }
    boundary = start;
  }
  if (boundary === 0 || boundary === value.length) {
    return boundary;
  }
  return endsInsideOpenConstruct(value.slice(boundary)) ? 0 : boundary;
}

/**
 * Whether `value` ends inside a construct whose next character rewrites the
 * text before it: a tag still streaming in, or a backslash waiting for the
 * character it escapes. No conversion of a value ending this way is final.
 */
export function endsInsideOpenConstruct(value: string): boolean {
  return PARTIAL_TAG_AT_END.test(value) || (value.length > 0 && value.endsWith('\\'));
}

/** The markdown for `value`, over the code ranges and root nodes it was scanned into. */
function renderMarkdown(
  value: string,
  masks: readonly MaskRange[],
  nodes: readonly HtmlNode[]
): string {
  const context: ConvertContext = { value, masks };
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
