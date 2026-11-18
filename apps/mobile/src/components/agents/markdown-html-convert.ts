import { blockLines, MARKDOWN_BLOCK_TAGS } from './markdown-html-block';
import { type ConvertContext, inlineContent } from './markdown-html-inline';
import { type HtmlElement, scanMarkdownCode } from './markdown-html-scan';
import { parseMarkdownHtml } from './markdown-html-tree';

const LINE_END = /[ \t]*(?:\n|$)/y;
// A line a `<br>` cannot continue: a heading, a quote, a list item, a table
// row, or indented code. The paragraph-only hard break would change its block.
const BREAK_BLOCKED_LINE = /^(?: {4}|\t|\s*(?:#|>|[-+*]\s|\d{1,9}[.)]\s))|\|/;
// A line that ends the paragraph before it, so a break before it draws nothing.
const PARAGRAPH_ENDING_LINE =
  /^(?:[ \t]*(?:\n|$)| {0,3}(?:#{1,6}(?:\s|$)|>|[-+*][ \t]|\d{1,9}[.)][ \t]|`{3}|~{3}|<|[=-]+[ \t]*(?:\n|$)|(?:[*_][ \t]*){3,}(?:\n|$)))/;

/**
 * A root `<br>` as markdown: a backslash break that continues the paragraph,
 * nothing where the paragraph ends anyway, or null on a line a break would
 * change. `skip` is the source after the tag the break already accounts for.
 */
function rootBreak(value: string, element: HtmlElement): { text: string; skip: number } | null {
  const lineStart = value.lastIndexOf('\n', element.start - 1) + 1;
  const lineEnd = value.indexOf('\n', element.end);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  if (value.slice(lineStart, element.start).trim() === '' || BREAK_BLOCKED_LINE.test(line)) {
    return null;
  }
  const rest = value.slice(element.end);
  const newline = /^[ \t]*(\n)?[ \t]*/.exec(rest);
  const following = rest.slice(newline?.[0].length ?? 0);
  if (following === '' || (newline?.[1] !== undefined && PARAGRAPH_ENDING_LINE.test(following))) {
    return { text: '', skip: 0 };
  }
  return { text: '\\\n', skip: newline?.[0].length ?? 0 };
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
  let markdown = '';
  let skip = 0;
  for (const node of nodes) {
    const skipped = skip;
    skip = 0;
    if (node.kind === 'text') {
      markdown += value.slice(node.start + Math.min(skipped, node.end - node.start), node.end);
    } else if (node.name === 'br') {
      const lineBreak = rootBreak(value, node);
      markdown += lineBreak?.text ?? value.slice(node.start, node.end);
      skip = lineBreak?.skip ?? 0;
    } else if (MARKDOWN_BLOCK_TAGS.has(node.name)) {
      const lines = rootBlock(context, node);
      markdown =
        lines === null
          ? markdown + value.slice(node.start, node.end)
          : appendBlock(markdown, lines, node.end < value.length);
    } else {
      const inline = inlineContent(context, [node], {
        allowBreak: false,
        inLink: false,
        before: markdown.at(-1),
        after: value[node.end],
      });
      markdown += inline ?? value.slice(node.start, node.end);
    }
  }
  return markdown;
}

/**
 * A converted block is its own markdown block: blank lines on both sides keep
 * it from joining the paragraph or list around it.
 */
function appendBlock(markdown: string, lines: readonly string[], more: boolean): string {
  let joined = markdown;
  if (joined !== '' && !joined.endsWith('\n\n')) {
    joined += joined.endsWith('\n') ? '\n' : '\n\n';
  }
  return joined + lines.join('\n') + (more ? '\n' : '');
}
