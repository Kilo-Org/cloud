import {
  type ConvertContext,
  decodeEntities,
  HARD_BREAK,
  inlineContent,
  type InlineOptions,
} from './markdown-html-inline';
import { type HtmlElement, type HtmlNode } from './markdown-html-scan';

/** Block tags with a markdown form; every other block tag stays HTML. */
export const MARKDOWN_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'ul',
  'ol',
  'pre',
  'hr',
  'table',
]);

type Block = { lines: string[]; list: boolean };

const SINGLE_LINE: InlineOptions = { allowBreak: false, inLink: false };
const PARAGRAPH: InlineOptions = { allowBreak: true, inLink: false };

const LINE_START_MARKER =
  /^(?:#{1,6}(?=\s|$)|[-+*](?=\s|$)|>|[=-]+[ \t]*$|`{3,}|~{3,}|(?:[*_][ \t]*){3,}$)/;
const ORDERED_MARKER = /^(\d{1,9})([.)])(?=\s|$)/;
const CODE_LANGUAGE = /^language-([\w+#.-]+)$/;

/** Text that would start a list, heading, or quote at a line start keeps reading as text. */
function escapeLineStart(line: string): string {
  return LINE_START_MARKER.test(line)
    ? `\\${line}`
    : line.replace(ORDERED_MARKER, String.raw`$1\$2`);
}

const isBlankText = (context: ConvertContext, node: HtmlNode) =>
  node.kind === 'text' && context.value.slice(node.start, node.end).trim() === '';

/** Paragraph lines for inline nodes; `<br>` ends a line with markdown's backslash break. */
function paragraphLines(context: ConvertContext, nodes: readonly HtmlNode[]): string[] | null {
  const content = inlineContent(context, nodes, PARAGRAPH);
  if (content === null) {
    return null;
  }
  const lines = content.split(HARD_BREAK).map(line => line.trim());
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  if (lines[0] === '' && lines.length > 0) {
    // A leading break draws an empty line markdown cannot start a paragraph with.
    return null;
  }
  return lines.map((line, index) =>
    index < lines.length - 1 ? `${escapeLineStart(line)}\\` : escapeLineStart(line)
  );
}

function blockChildren(context: ConvertContext, nodes: readonly HtmlNode[]): Block[] | null {
  const blocks: Block[] = [];
  let run: HtmlNode[] = [];
  const flush = () => {
    const lines = paragraphLines(context, run);
    run = [];
    if (lines?.length) {
      blocks.push({ lines, list: false });
    }
    return lines !== null;
  };
  for (const node of nodes) {
    if (node.kind === 'text' || !MARKDOWN_BLOCK_TAGS.has(node.name)) {
      run.push(node);
    } else {
      const lines = flush() ? blockLines(context, node) : null;
      if (lines === null) {
        return null;
      }
      if (lines.length > 0) {
        blocks.push({ lines, list: node.name === 'ul' || node.name === 'ol' });
      }
    }
  }
  return flush() ? blocks : null;
}

/** Blocks joined by blank lines, except a nested list, which follows its item's text directly. */
function joinBlocks(blocks: readonly Block[], tightLists: boolean): string[] {
  return blocks.flatMap((block, index) =>
    index === 0 || (tightLists && block.list) ? block.lines : ['', ...block.lines]
  );
}

function listLines(context: ConvertContext, list: HtmlElement): string[] | null {
  const start = list.attributes.get('start');
  const startValid = list.name === 'ol' && start !== undefined && /^\d{1,9}$/.test(start);
  if (list.attributes.size > (startValid ? 1 : 0)) {
    return null;
  }
  let number = startValid ? Number(start) : 1;
  const lines: string[] = [];
  for (const item of list.children.filter(child => !isBlankText(context, child))) {
    if (item.kind !== 'element' || item.name !== 'li' || item.attributes.size > 0) {
      return null;
    }
    const blocks = item.malformed ? null : blockChildren(context, item.children);
    if (blocks === null) {
      return null;
    }
    const marker = list.name === 'ol' ? `${number}.` : '-';
    const indent = ' '.repeat(marker.length + 1);
    const [first = '', ...rest] = joinBlocks(blocks, true);
    lines.push(first === '' ? marker : `${marker} ${first}`);
    lines.push(...rest.map(line => (line === '' ? '' : indent + line)));
    number += 1;
  }
  return lines;
}

type TableRow = { cells: HtmlElement[]; head: boolean };

function tableRows(context: ConvertContext, table: HtmlElement): TableRow[] | null {
  const rows: TableRow[] = [];
  const addRow = (row: HtmlNode, head: boolean) => {
    if (row.kind !== 'element' || row.name !== 'tr' || row.attributes.size > 0 || row.malformed) {
      return false;
    }
    const cells = row.children.filter(cell => !isBlankText(context, cell));
    const valid = cells.every(
      cell => cell.kind === 'element' && (cell.name === 'td' || cell.name === 'th')
    );
    rows.push({ cells: cells.filter(cell => cell.kind === 'element'), head });
    return valid;
  };
  for (const child of table.children.filter(node => !isBlankText(context, node))) {
    const section = child.kind === 'element' && (child.name === 'thead' || child.name === 'tbody');
    const valid = section
      ? child.attributes.size === 0 &&
        child.children.every(
          row => isBlankText(context, row) || addRow(row, child.name === 'thead')
        )
      : addRow(child, false);
    if (!valid) {
      return null;
    }
  }
  return rows;
}

function cellMarkdown(context: ConvertContext, cell: HtmlElement): string | null {
  const content =
    cell.attributes.size > 0 || cell.malformed
      ? null
      : inlineContent(context, cell.children, SINGLE_LINE);
  return content === null ? null : content.trim().replaceAll(/(?<!\\)\|/g, String.raw`\|`);
}

/** A GFM table for a table of plain rows; null for spans, attributes, or block cells. */
function tableLines(context: ConvertContext, table: HtmlElement): string[] | null {
  const rows = table.attributes.size > 0 ? null : tableRows(context, table);
  if (rows === null) {
    return null;
  }
  const [header, ...body] = rows;
  if (header === undefined) {
    return [];
  }
  const headerValid = header.head || header.cells.every(cell => cell.name === 'th');
  const bodyValid = body.every(
    row =>
      !row.head &&
      row.cells.length <= header.cells.length &&
      row.cells.every(cell => cell.name === 'td')
  );
  if (!headerValid || !bodyValid || header.cells.length === 0) {
    return null;
  }
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.cells.map(cell => cellMarkdown(context, cell));
    if (cells.includes(null)) {
      return null;
    }
    const padded = [
      ...cells,
      ...Array.from({ length: header.cells.length - cells.length }, () => ''),
    ];
    lines.push(`| ${padded.join(' | ')} |`);
    if (row === header) {
      lines.push(`| ${padded.map(() => '---').join(' | ')} |`);
    }
  }
  return lines;
}

/** A fenced code block for `<pre>` or `<pre><code class="language-x">`. */
function preLines(context: ConvertContext, pre: HtmlElement): string[] | null {
  const content = pre.children.filter(child => !isBlankText(context, child));
  const [only] = content;
  const code = content.length === 1 && only?.kind === 'element' ? only : undefined;
  const language = code?.attributes.get('class');
  const languageMatch = language === undefined ? null : CODE_LANGUAGE.exec(language);
  const source = code ?? pre;
  const codeValid =
    code === undefined
      ? pre.children.every(child => child.kind === 'text')
      : code.name === 'code' &&
        !code.malformed &&
        code.attributes.size === (languageMatch ? 1 : 0) &&
        code.children.every(child => child.kind === 'text');
  if (pre.attributes.size > 0 || !codeValid) {
    return null;
  }
  const decoded = decodeEntities(context.value.slice(source.contentStart, source.contentEnd));
  if (decoded === null) {
    return null;
  }
  const text = decoded.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${languageMatch?.[1] ?? ''}`, ...text.split('\n'), fence];
}

function headingLines(context: ConvertContext, heading: HtmlElement, level: number) {
  const content = inlineContent(context, heading.children, SINGLE_LINE)?.trim();
  if (content === undefined || content === '') {
    return content === undefined ? null : [];
  }
  // A trailing ` #` run would read as the heading's closing sequence.
  return [`${'#'.repeat(level)} ${content.replace(/(\s)#(#*)$/, String.raw`$1\#$2`)}`];
}

/** Markdown lines for a block element, or null when it has no lossless markdown form. */
export function blockLines(context: ConvertContext, element: HtmlElement): string[] | null {
  if (element.malformed || element.containsBlockCode) {
    return null;
  }
  const { name, attributes } = element;
  if (name === 'ul' || name === 'ol') {
    return listLines(context, element);
  }
  if (name === 'table') {
    return tableLines(context, element);
  }
  if (name === 'pre') {
    return preLines(context, element);
  }
  if (attributes.size > 0) {
    return null;
  }
  if (name === 'hr') {
    return ['---'];
  }
  if (name === 'blockquote') {
    const blocks = blockChildren(context, element.children);
    return blocks && joinBlocks(blocks, false).map(line => (line === '' ? '>' : `> ${line}`));
  }
  const level = /^h([1-6])$/.exec(name)?.[1];
  if (level !== undefined) {
    return headingLines(context, element, Number(level));
  }
  return name === 'p' ? paragraphLines(context, element.children) : null;
}
