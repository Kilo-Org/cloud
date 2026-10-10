import { type HtmlElement, type HtmlNode, type MaskRange } from './markdown-html-scan';

// Sets, not object literals: tag names come from the message, and a name like
// `constructor` must not find an inherited member.
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

// Tags whose contents the HTML parser reads as text, never as markup.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

// Block-level tags: they close an open `<p>` and keep a blank line from
// closing the tags open inside them.
const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'center',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

// Tags HTML closes without an end tag; skipping over one is not malformed.
const IMPLIED_END_TAGS: ReadonlySet<string> = new Set([
  'li',
  'p',
  'td',
  'th',
  'tr',
  'thead',
  'tbody',
  'tfoot',
]);

const CELLS = { targets: new Set(['td', 'th']), barriers: new Set(['tr', 'table']) };
const SECTIONS = {
  targets: new Set(['thead', 'tbody', 'tfoot']),
  barriers: new Set(['table']),
};
// An opening tag that implicitly closes the nearest open sibling of the same
// family, unless a barrier (its container) is open in between.
const IMPLIED_CLOSES: ReadonlyMap<
  string,
  { targets: ReadonlySet<string>; barriers: ReadonlySet<string> }
> = new Map([
  ['li', { targets: new Set(['li']), barriers: new Set(['ul', 'ol']) }],
  ['td', CELLS],
  ['th', CELLS],
  ['tr', { targets: new Set(['tr']), barriers: new Set(['table', 'thead', 'tbody', 'tfoot']) }],
  ['thead', SECTIONS],
  ['tbody', SECTIONS],
  ['tfoot', SECTIONS],
]);

const OPEN_TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CLOSE_TAG = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/y;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const BLANK_LINE_AFTER_NEWLINE = /[ \t]*(?:\n|$)/y;
// A tag still streaming in at the end of the value: `<`, `</`, `<td`, `<a href="x`.
const PARTIAL_TAG = /<\/?(?:[a-zA-Z][^<>]*)?$/;

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Parses the HTML tags of `value` outside code into a tree of root nodes in
 * source order. Text between tags, code included, becomes text nodes. Tags
 * close the way an HTML parser closes them (`<li>` ends the previous `<li>`);
 * a tag left open at a blank line or a code block closes there when no block
 * tag is open, as markdown ends the paragraph that holds it; anything still
 * open at the end of the value closes there, minus a tag still streaming in.
 */
export function parseMarkdownHtml(value: string, masks: readonly MaskRange[]): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: HtmlElement[] = [];
  let textStart = 0;

  const siblings = () => stack.at(-1)?.children ?? root;
  const pushText = (end: number) => {
    if (end > textStart) {
      siblings().push({ kind: 'text', start: textStart, end });
    }
  };
  const closeFrom = (depth: number, at: number) => {
    for (const element of stack.splice(depth)) {
      element.contentEnd = at;
      element.end = at;
      element.malformed ||= !IMPLIED_END_TAGS.has(element.name);
    }
  };
  const blockOpen = () => stack.some(element => HTML_BLOCK_TAGS.has(element.name));
  const endParagraph = (at: number) => {
    pushText(at);
    for (const element of stack.splice(0)) {
      element.contentEnd = at;
      element.end = at;
    }
    textStart = at;
  };

  /** Steps over a code range; returns where scanning resumes. */
  const skipMask = (mask: MaskRange, index: number): number => {
    if (stack.length === 0) {
      return Math.max(index, mask.end);
    }
    if (mask.unclosed) {
      // A backtick inside an open element (`<code>a`b</code>`) cannot be a
      // span still streaming in past the element's own close tag: it is text.
      return index;
    }
    if (mask.block && blockOpen()) {
      for (const element of stack) {
        element.containsBlockCode = true;
      }
    } else if (mask.block) {
      endParagraph(mask.start);
    }
    return Math.max(index, mask.end);
  };

  const closeTag = (name: string, start: number, end: number) => {
    const depth = stack.findLastIndex(element => element.name === name);
    const element = stack[depth];
    if (element) {
      pushText(start);
      closeFrom(depth + 1, start);
      stack.splice(depth);
      element.contentEnd = start;
      element.end = end;
      textStart = end;
    }
  };

  const openTag = (open: RegExpExecArray, start: number, end: number): number => {
    const name = open[1]?.toLowerCase() ?? '';
    pushText(start);
    const implied = IMPLIED_CLOSES.get(name);
    const openNames = stack.map(element => element.name);
    const barrier = implied ? openNames.findLastIndex(tag => implied.barriers.has(tag)) : -1;
    const target = implied ? openNames.findLastIndex(tag => implied.targets.has(tag)) : -1;
    if (target > barrier) {
      closeFrom(target, start);
    } else if (!implied && HTML_BLOCK_TAGS.has(name) && stack.at(-1)?.name === 'p') {
      closeFrom(stack.length - 1, start);
    }
    const element: HtmlElement = {
      kind: 'element',
      name,
      attributes: parseAttributes(open[2] ?? ''),
      start,
      contentStart: end,
      contentEnd: end,
      end,
      children: [],
      malformed: false,
      containsBlockCode: false,
    };
    siblings().push(element);
    textStart = end;
    if (VOID_TAGS.has(name) || open[3] === '/') {
      return end;
    }
    stack.push(element);
    if (!RAW_TEXT_TAGS.has(name)) {
      return end;
    }
    const rawClose = value.toLowerCase().indexOf(`</${name}`, end);
    return rawClose === -1 ? value.length : rawClose;
  };

  /** Reads the tag at `index`, if one ends before `limit`; returns where scanning resumes. */
  const readTag = (index: number, limit: number): number => {
    CLOSE_TAG.lastIndex = index;
    const close = CLOSE_TAG.exec(value);
    const closeEnd = CLOSE_TAG.lastIndex;
    if (close && closeEnd <= limit) {
      closeTag(close[1]?.toLowerCase() ?? '', index, closeEnd);
      return closeEnd;
    }
    OPEN_TAG.lastIndex = index;
    const open = OPEN_TAG.exec(value);
    const openEnd = OPEN_TAG.lastIndex;
    return open && openEnd <= limit ? openTag(open, index, openEnd) : index + 1;
  };

  let index = 0;
  let maskIndex = 0;
  while (index < value.length) {
    const mask = masks[maskIndex];
    const char = value[index];
    if (mask && index >= mask.start) {
      index = skipMask(mask, index);
      maskIndex += 1;
    } else if (char === '\n' && stack.length > 0 && !blockOpen()) {
      BLANK_LINE_AFTER_NEWLINE.lastIndex = index + 1;
      if (BLANK_LINE_AFTER_NEWLINE.test(value)) {
        endParagraph(index);
      }
      index += 1;
    } else if (char === '<' && !isEscaped(value, index)) {
      index = readTag(index, mask?.start ?? value.length);
    } else {
      index += 1;
    }
  }

  pushText(value.length);
  const top = stack.at(-1);
  const last = top?.children.at(-1);
  const partial =
    last?.kind === 'text' ? PARTIAL_TAG.exec(value.slice(last.start, last.end)) : null;
  if (last && partial) {
    last.end -= partial[0].length;
    if (last.end === last.start) {
      top?.children.pop();
    }
  }
  for (const element of stack) {
    element.contentEnd = last?.kind === 'text' && element === top ? last.end : value.length;
    element.end = value.length;
  }
  return root;
}
