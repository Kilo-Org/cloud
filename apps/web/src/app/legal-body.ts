// The mobile reader draws a legal document's title in its own header, so the
// body it is handed must start at the document content, not at the source page's
// title. The loaders pass this module sanitize-html output — quoted attributes,
// escaped text, no comments — so a small tag scanner is enough, and removing the
// title by source range keeps every later byte of the document untouched.

type TextNode = { kind: 'text'; start: number; end: number; value: string };

type VoidNode = { kind: 'void'; start: number; end: number };

type ElementNode = {
  kind: 'element';
  name: string;
  start: number;
  end: number;
  parent: ElementNode | null;
  children: DocumentNode[];
};

type DocumentNode = TextNode | VoidNode | ElementNode;

const HEADING_NAME = /^h[1-6]$/i;

// The elements sanitize-html emits without a closing tag, as `<br />`.
const VOID_ELEMENTS: Record<string, true> = { br: true, hr: true, img: true };

const TAG_OPENING = /^<(\/?)([a-z][^\s/>]*)/i;

// Returns the index just past the tag's `>`, or -1 when the scan cannot find it.
// Attribute values are quoted, so a `>` inside one does not end the tag.
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index + 1;
    }
  }
  return -1;
}

// Builds the element tree, or returns null for markup the scanner cannot trust
// (unbalanced tags, a declaration or comment). The title is data entry: a
// document that fails this check is served exactly as loaded.
function parseDocument(html: string): DocumentNode[] | null {
  const root: ElementNode = {
    kind: 'element',
    name: '#document',
    start: 0,
    end: html.length,
    parent: null,
    children: [],
  };
  const open: ElementNode[] = [];

  const append = (node: DocumentNode) => {
    (open.at(-1) ?? root).children.push(node);
    if (node.kind === 'element') node.parent = open.at(-1) ?? root;
  };

  let index = 0;
  while (index < html.length) {
    if (html[index] !== '<') {
      const next = html.indexOf('<', index);
      const end = next === -1 ? html.length : next;
      append({ kind: 'text', start: index, end, value: html.slice(index, end) });
      index = end;
      continue;
    }

    const tagEnd = findTagEnd(html, index);
    if (tagEnd === -1) return null;

    const opening = TAG_OPENING.exec(html.slice(index, tagEnd));
    if (!opening) return null;

    const closing = opening[1] === '/';
    const name = opening[2].toLowerCase();
    const current = open.at(-1) ?? root;

    if (closing) {
      if (current.name !== name) return null;
      current.end = tagEnd;
      open.pop();
    } else if (VOID_ELEMENTS[name]) {
      append({ kind: 'void', start: index, end: tagEnd });
    } else {
      append({ kind: 'element', name, start: index, end: -1, parent: null, children: [] });
      open.push(current.children.at(-1) as ElementNode);
    }

    index = tagEnd;
  }

  return open.length === 0 ? root.children : null;
}

// The first real content in document order. Wrappers that hold nothing before
// the title are descended into; anything other than a heading there means the
// document does not lead with its title.
function findLeadingHeading(nodes: DocumentNode[]): ElementNode | 'content' | null {
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.value.trim() !== '') return 'content';
      continue;
    }
    if (node.kind === 'void') return 'content';
    if (HEADING_NAME.test(node.name)) return node;

    const nested = findLeadingHeading(node.children);
    if (nested !== null) return nested;
  }
  return null;
}

export function stripLeadingDocumentTitle(html: string): string {
  const nodes = parseDocument(html);
  if (nodes === null) return html;

  const heading = findLeadingHeading(nodes);
  if (heading === null || heading === 'content') return html;

  // Drop every ancestor the removal leaves holding nothing but whitespace, so a
  // title wrapper does not survive as an empty element ahead of the content.
  let top: DocumentNode = heading;
  let ancestor = heading.parent;
  while (ancestor && ancestor.parent !== null) {
    const holdsContent = ancestor.children.some(
      (child) => child !== top && !(child.kind === 'text' && child.value.trim() === '')
    );
    if (holdsContent) break;
    top = ancestor;
    ancestor = ancestor.parent;
  }

  const prefix = html.slice(0, top.start);
  return (prefix.trim() === '' ? '' : prefix) + html.slice(top.end);
}
