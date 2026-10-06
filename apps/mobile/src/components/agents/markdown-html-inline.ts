import { type HtmlElement, type HtmlNode, type MaskRange } from './markdown-html-scan';
import { toScriptText } from './markdown-html-script';

/** The source a conversion reads: the markdown value and its code ranges. */
export type ConvertContext = { value: string; masks: readonly MaskRange[] };

/**
 * Where inline content lands: whether a `<br>` may become a line break, whether
 * it is already inside link text, and the output characters around it, which
 * decide whether markdown reads a `**` there as emphasis (undefined: an edge).
 */
export type InlineOptions = {
  allowBreak: boolean;
  inLink: boolean;
  before?: string;
  after?: string;
};

/**
 * Stands in for `<br>` until a block splits its content into lines; a private
 * use character, so no text and no whitespace pattern can produce or eat it.
 */
export const HARD_BREAK = '\uE000';

// Maps and sets, not object literals: tag and entity names come from the
// message, and a name like `constructor` must not find an inherited member.
const EMPHASIS_DELIMITERS: ReadonlyMap<string, string> = new Map([
  ['b', '**'],
  ['strong', '**'],
  ['i', '*'],
  ['em', '*'],
  ['s', '~~'],
  ['del', '~~'],
  ['strike', '~~'],
]);
// The attributes markdown keeps (or that change nothing in the app); any other
// attribute keeps the element HTML.
const KEPT_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['a', new Set(['href', 'title', 'target', 'rel'])],
  ['img', new Set(['src', 'alt', 'title'])],
]);
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00A0'],
]);
const MAX_CODE_POINT = 1_114_111;

const WHITESPACE_RUN = /\s+/g;
const ENTITY = /&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]*);/g;
const SPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const EDGE_WHITESPACE = /^(\s*)([\s\S]*?)(\s*)$/;

/**
 * A run of inline markdown. Emphasis keeps its delimiter apart until it is
 * joined, because markdown decides from the characters around `**` whether it
 * opens and closes; plain text has an empty delimiter.
 */
type InlinePiece = { delimiter: string; lead: string; core: string; trail: string };

const text = (core: string): InlinePiece => ({ delimiter: '', lead: '', core, trail: '' });

/** Collapses whitespace as HTML does, except inside code spans, whose spaces markdown keeps. */
function renderText(context: ConvertContext, start: number, end: number): string {
  const { value, masks } = context;
  let low = 0;
  let high = masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((masks[middle]?.end ?? 0) <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let rendered = '';
  let cursor = start;
  for (const mask of masks.slice(low)) {
    if (mask.start >= end) {
      break;
    }
    const maskStart = Math.max(mask.start, cursor);
    const maskEnd = Math.min(mask.end, end);
    rendered += value.slice(cursor, maskStart).replace(WHITESPACE_RUN, ' ');
    rendered += value.slice(maskStart, maskEnd).replaceAll('\n', ' ');
    cursor = maskEnd;
  }
  return rendered + value.slice(cursor, end).replace(WHITESPACE_RUN, ' ');
}

/** Decodes the entities code text needs as characters; null for one it does not know. */
export function decodeEntities(source: string): string | null {
  for (const [, body = ''] of source.matchAll(ENTITY)) {
    if (!body.startsWith('#') && !NAMED_ENTITIES.has(body)) {
      return null;
    }
  }
  return source.replace(ENTITY, (entity, body: string) => {
    if (!body.startsWith('#')) {
      return NAMED_ENTITIES.get(body) ?? entity;
    }
    const hex = body[1] === 'x' || body[1] === 'X';
    const codePoint = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return codePoint > 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
  });
}

// CommonMark's flanking rules: `**x**` is emphasis only when the opening run is
// left-flanking and the closing run right-flanking, judged from the characters
// around each run. The value's edges count as whitespace.
function delimiterFits(before: string | undefined, core: string, after: string | undefined) {
  const isSpace = (char: string | undefined) => char === undefined || SPACE.test(char);
  const isPunctuation = (char: string | undefined) => char !== undefined && PUNCTUATION.test(char);
  const first = core[0];
  const last = core.at(-1);
  const opens =
    !isSpace(first) && (!isPunctuation(first) || isSpace(before) || isPunctuation(before));
  const closes = !isSpace(last) && (!isPunctuation(last) || isSpace(after) || isPunctuation(after));
  // `**x\**` escapes its own closing run, and a break at an edge splits the
  // emphasis across lines.
  return (
    opens &&
    closes &&
    !core.endsWith('\\') &&
    !core.startsWith(HARD_BREAK) &&
    !core.endsWith(HARD_BREAK)
  );
}

/**
 * Joins inline pieces; null when an emphasis would not parse back as emphasis,
 * or when two backtick runs would touch, inside the run or at its edges:
 * `a``b` reads as one code span, so adjacent `<kbd>`/`<code>` keep their HTML.
 */
function joinInline(pieces: readonly InlinePiece[], options: InlineOptions): string | null {
  let joined = '';
  // Set inside `append`, which flow analysis does not follow.
  let backticksTouch = false as boolean;
  // Collapsing across piece edges, as HTML collapses whitespace across tags.
  const append = (part: string) => {
    backticksTouch ||=
      part.startsWith('`') && (joined === '' ? options.before === '`' : joined.endsWith('`'));
    joined += joined.endsWith(' ') && part.startsWith(' ') ? part.slice(1) : part;
  };
  for (const [index, piece] of pieces.entries()) {
    append(piece.lead);
    if (piece.delimiter !== '') {
      let next = piece.trail[0];
      for (const following of pieces.slice(index + 1)) {
        next ??= (following.lead + following.delimiter + following.core)[0];
      }
      const previous = joined.length > 0 ? joined.at(-1) : options.before;
      if (!delimiterFits(previous, piece.core, next ?? options.after)) {
        return null;
      }
    }
    append(piece.delimiter + piece.core + piece.delimiter);
    append(piece.trail);
  }
  return backticksTouch || (joined.endsWith('`') && options.after === '`') ? null : joined;
}

function linkDestination(href: string): string | null {
  if (href === '' || /[\n<>\\]/.test(href)) {
    return null;
  }
  return /[\s()]/.test(href) ? `<${href}>` : href;
}

function linkTitle(title: string | undefined): string | null {
  if (title === undefined) {
    return '';
  }
  return title.includes('\n') ? null : ` "${title.replaceAll(/["\\]/g, String.raw`\$&`)}"`;
}

function bracketsBalanced(content: string): boolean {
  let depth = 0;
  for (let index = 0; index < content.length && depth >= 0; index += 1) {
    const char = content[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
    }
  }
  return depth === 0;
}

function codeSpan(context: ConvertContext, element: HtmlElement): string | null {
  if (element.children.some(child => child.kind === 'element')) {
    return null;
  }
  const decoded = decodeEntities(context.value.slice(element.contentStart, element.contentEnd));
  if (decoded === null) {
    return null;
  }
  const content = decoded.replace(WHITESPACE_RUN, ' ');
  if (content === '') {
    return '';
  }
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const fence = '`'.repeat(longest + 1);
  // Markdown strips one space from each side of a code span; pad so the
  // content's own edge spaces and backticks survive.
  const pad =
    content.startsWith('`') ||
    content.endsWith('`') ||
    (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '')
      ? ' '
      : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

/**
 * The script form of a text-only `sub`/`sup`; null when it has none. Edge
 * whitespace has no script form either, so content that needs it stays HTML.
 */
function scriptText(context: ConvertContext, element: HtmlElement): string | null {
  if (element.children.some(child => child.kind === 'element')) {
    return null;
  }
  const decoded = decodeEntities(context.value.slice(element.contentStart, element.contentEnd));
  return decoded === null ? null : toScriptText(decoded, element.name === 'sup' ? 'sup' : 'sub');
}

function elementPiece(
  context: ConvertContext,
  element: HtmlElement,
  options: InlineOptions
): InlinePiece | null {
  const delimiter = EMPHASIS_DELIMITERS.get(element.name);
  if (delimiter !== undefined) {
    const neighbour = delimiter[0];
    const inner = inlineContent(context, element.children, {
      ...options,
      before: neighbour,
      after: neighbour,
    });
    const [, lead = '', core = '', trail = ''] = EDGE_WHITESPACE.exec(inner ?? '') ?? [];
    if (inner === null) {
      return null;
    }
    return core === '' ? text(lead + trail) : { delimiter, lead, core, trail };
  }
  if (element.name === 'code' || element.name === 'kbd') {
    // A key reads as inline code: the native renderer draws it on the line's
    // baseline, where an offset key box would be clipped on iOS.
    const code = codeSpan(context, element);
    return code === null ? null : text(code);
  }
  if (element.name === 'sub' || element.name === 'sup') {
    const scripted = scriptText(context, element);
    return scripted === null ? null : text(scripted);
  }
  if (element.name === 'br') {
    return options.allowBreak ? text(HARD_BREAK) : null;
  }
  if (element.name === 'img') {
    const src = element.attributes.get('src') ?? '';
    const destination = src.startsWith('https://') ? linkDestination(src) : null;
    const title = linkTitle(element.attributes.get('title'));
    if (destination === null || title === null) {
      return null;
    }
    const alt = (element.attributes.get('alt') ?? '')
      .replace(WHITESPACE_RUN, ' ')
      .replaceAll(/[\\[\]]/g, String.raw`\$&`);
    return text(`![${alt}](${destination}${title})`);
  }
  if (element.name !== 'a' || options.inLink) {
    return null;
  }
  const destination = linkDestination(element.attributes.get('href') ?? '');
  const title = linkTitle(element.attributes.get('title'));
  const label = inlineContent(context, element.children, {
    ...options,
    inLink: true,
    before: '[',
    after: ']',
  });
  if (destination === null || title === null || label === null || !bracketsBalanced(label)) {
    return null;
  }
  return text(`[${label.trim()}](${destination}${title})`);
}

function inlinePiece(
  context: ConvertContext,
  node: HtmlNode,
  options: InlineOptions
): InlinePiece | null {
  if (node.kind === 'text') {
    return text(renderText(context, node.start, node.end));
  }
  const kept = KEPT_ATTRIBUTES.get(node.name);
  const attributesKept = [...node.attributes.keys()].every(name => kept?.has(name) === true);
  if (node.malformed || node.containsBlockCode || !attributesKept) {
    return null;
  }
  return elementPiece(context, node, options);
}

/** Inline markdown for `nodes`, or null when any of them has no lossless markdown form. */
export function inlineContent(
  context: ConvertContext,
  nodes: readonly HtmlNode[],
  options: InlineOptions
): string | null {
  const pieces: InlinePiece[] = [];
  for (const node of nodes) {
    const piece = inlinePiece(context, node, options);
    if (piece === null) {
      return null;
    }
    pieces.push(piece);
  }
  return joinInline(pieces, options);
}
