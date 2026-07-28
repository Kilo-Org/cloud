// Per-line syntax highlighting for diff lines, using `lowlight`
// (highlight.js wrapped to return a hast tree instead of mutating the
// DOM).
//
// The accepted v1 ceiling is per-line highlighting: each line of a diff
// is highlighted independently. Multi-line tokens (a block comment
// that opens on line 5 and closes on line 12) may mis-color on lines
// 6–11 because the highlighter doesn't know the comment is still open.
// This is the same trade-off GitHub's mobile web view made and the
// PR-review surface is not the place to ship a multi-line tokenizer —
// callers should still get a clean, readable result, and the cost of
// wiring a per-hunk state machine is out of scope for S6b.
//
// The hast tree is then converted to a flat list of
// `{text, className}` spans so a React Native `<Text>` can render it
// with nested `<Text>` runs. The class names we produce are a small
// fixed token palette (`tok-keyword`, `tok-string`, ...) derived from
// the app's theme — the rendering side turns those into concrete
// colors with dark variants. We don't use raw `hljs-*` classes because
// the diff surface shouldn't depend on the full highlight.js CSS
// theme being loaded.
//
// A small LRU cache sits on top of the per-line path because a large
// diff can have thousands of identical lines (empty context rows) and
// re-running the tokenizer for each one is wasteful.

import { common, createLowlight } from 'lowlight';

// Lazy singleton — the common grammar set is ~1 MB, instantiating it
// once per module load (and not at all in tests that don't import
// anything that calls it) keeps the bundle and cold-start cost
// contained.
type LowlightInstance = ReturnType<typeof createLowlight>;
let lowlightInstance: LowlightInstance | null = null;

function getLowlight(): LowlightInstance {
  lowlightInstance ??= createLowlight(common);
  return lowlightInstance;
}

// Extension → language name. Anything not in this map is highlighted
// as plain text (the underlying `lowlight.highlight` will still return
// a single text node, so callers get a valid result back without
// throwing). Filenames are lower-cased and the last extension is
// matched so `foo.test.ts` resolves to `typescript`.
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  sql: 'sql',
  graphql: 'graphql',
};

export function languageForPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  const slash = path.lastIndexOf('/');
  const basename = slash !== -1 ? path.slice(slash + 1) : path;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const ext = basename.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

export type HighlightToken = {
  text: string;
  /**
   * The token-color palette key (`keyword`, `string`, `comment`, ...).
   * `null` for plain text runs the highlighter didn't tag.
   */
  className: string | null;
};

// Map a highlight.js class name to our smaller palette. We don't ship
// every hljs sub-language — only the ones that show up in the
// reviewer surface often enough to be worth coloring.
const HLJS_CLASS_PALETTE: Record<string, string> = {
  // Keywords / control flow
  keyword: 'keyword',
  built_in: 'builtin',
  'builtin-name': 'builtin',
  literal: 'literal',
  symbol: 'literal',
  boolean: 'literal',
  number: 'number',
  'function-variable': 'function',
  'class-name': 'type',
  type: 'type',
  'title.function': 'function',
  'title.class': 'type',
  function: 'function',
  attr: 'attribute',
  attribute: 'attribute',
  variable: 'variable',
  template_variable: 'variable',
  params: 'variable',
  property: 'property',
  tag: 'tag',
  selector: 'selector',
  selector_tag: 'selector',
  selector_class: 'selector',
  selector_id: 'selector',
  selector_pseudo: 'selector',
  // Literals
  string: 'string',
  regexp: 'string',
  meta_string: 'string',
  subst: 'string',
  char: 'string',
  // Comments / doc
  comment: 'comment',
  doctag: 'comment',
  quote: 'string',
  // Operators / punctuation
  operator: 'operator',
  punctuation: 'operator',
  // Misc
  meta: 'meta',
  addition: 'add',
  deletion: 'del',
};

// Cap the per-line cache at 5,000 entries — large diffs can have many
// repeated short lines (empty context rows, import lines) but a hard
// ceiling keeps memory bounded for an attacker-controlled patch.
const HIGHLIGHT_CACHE_LIMIT = 5000;
const highlightCache = new Map<string, HighlightToken[]>();

function tokenFromHljsClassNames(classNames: readonly string[]): string | null {
  for (const name of classNames) {
    const palette = HLJS_CLASS_PALETTE[name];
    if (palette) {
      return palette;
    }
    // highlight.js also prefixes with `hljs-` for some grammars; strip
    // the prefix and try again.
    if (name.startsWith('hljs-')) {
      const stripped = name.slice('hljs-'.length);
      const palette2 = HLJS_CLASS_PALETTE[stripped];
      if (palette2) {
        return palette2;
      }
    }
  }
  return null;
}

type HastNode = {
  type: string;
  // hast element nodes carry `properties: { className?: string[] }`.
  properties?: { className?: string[] };
  // hast text nodes carry `value: string`.
  value?: string;
  children?: HastNode[];
};

function flattenHast(node: HastNode, out: HighlightToken[]): void {
  if (node.type === 'text' || node.type === 'root') {
    // The root node carries the per-line wrapper; we still want its
    // text children to come out as plain runs.
    if (node.value) {
      out.push({ text: node.value, className: null });
    }
    if (node.children) {
      for (const child of node.children) {
        flattenHast(child, out);
      }
    }
    return;
  }
  if (node.type === 'element') {
    const classNames = node.properties?.className ?? [];
    const token = tokenFromHljsClassNames(classNames);
    // For an element, gather all descendant text into a single token
    // run so React Native's <Text> nests cleanly. This is what GitHub
    // does in its tree-sitter-backed view as well.
    const text = collectText(node);
    if (text.length > 0) {
      out.push({ text, className: token });
    }
    return;
  }
  if (node.value) {
    out.push({ text: node.value, className: null });
  }
}

function collectText(node: HastNode): string {
  if (node.type === 'text') {
    return node.value ?? '';
  }
  if (!node.children) {
    return '';
  }
  let result = '';
  for (const child of node.children) {
    result += collectText(child);
  }
  return result;
}

/**
 * Highlight a single line of source code into a flat list of
 * `{text, className}` tokens. The highlighter is run per-line so
 * multi-line tokens (block comments, multi-line strings) may be
 * mis-colored on continuation lines — this is the accepted v1
 * ceiling and matches GitHub's mobile web view.
 *
 * Returns a single plain-text run if the language is unknown or the
 * highlighter throws on malformed input.
 */
export function highlightLine(text: string, language: string | null): HighlightToken[] {
  if (!language) {
    return [{ text, className: null }];
  }
  const cacheKey = `${language}\u0000${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    // LRU touch — re-insert to move to the end of insertion order.
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }
  const tokens = runHighlight(text, language);
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    // Drop the oldest entry. Map iteration is insertion-ordered, so
    // the first key is the least-recently-used.
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) {
      highlightCache.delete(oldest);
    }
  }
  highlightCache.set(cacheKey, tokens);
  return tokens;
}

function runHighlight(text: string, language: string): HighlightToken[] {
  try {
    const tree = getLowlight().highlight(language, text);
    const tokens: HighlightToken[] = [];
    // The root node has a single span child whose children carry the
    // real classes. We flatten through `flattenHast` to get one
    // token per contiguous text/class run.
    flattenHast(tree as unknown as HastNode, tokens);
    if (tokens.length === 0 && text.length > 0) {
      return [{ text, className: null }];
    }
    return tokens;
  } catch {
    // The grammar threw (e.g. unknown language) — fall back to plain.
    return [{ text, className: null }];
  }
}

/**
 * For tests: clear the per-line cache so a test that swaps the
 * singleton (e.g. to register a custom grammar) gets a fresh state.
 */
export function clearHighlightCacheForTests(): void {
  highlightCache.clear();
  lowlightInstance = null;
}
