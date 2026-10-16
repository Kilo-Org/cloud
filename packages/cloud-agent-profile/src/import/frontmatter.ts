/**
 * Minimal YAML-subset parser for markdown frontmatter. Supports the scalar
 * keys and one-or-more-level nested maps that agent/command definitions use
 * (for example `permission`); lists and other YAML constructs are reported as
 * invalid frontmatter rather than silently mis-mapped.
 */
export type FrontmatterParseResult =
  | { status: 'none' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: Record<string, unknown>; body: string };

type SourceLine = {
  indent: number;
  text: string;
};

class FrontmatterError extends Error {}

function splitIndentedLines(block: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const raw of block.split('\n')) {
    if (raw.trim().length === 0) continue;
    if (raw.trimStart().startsWith('#')) continue;
    let indent = 0;
    while (raw[indent] === ' ') indent += 1;
    if (raw[indent] === '\t') {
      throw new FrontmatterError('Tabs are not supported for frontmatter indentation');
    }
    lines.push({ indent, text: raw.slice(indent) });
  }
  return lines;
}

/** YAML indicators this subset does not decode, so they are rejected, not mis-mapped. */
const UNSUPPORTED_VALUE_PREFIXES = new Set(['[', '{', '|', '>']);

/**
 * YAML node indicators (anchor `&`, alias `*`, tag `!`) this subset cannot
 * resolve. An unquoted node carrying one is rejected rather than imported as
 * its literal text, which would silently change the field's value.
 */
const UNSUPPORTED_NODE_PREFIXES = new Set(['&', '*', '!']);

function rejectUnsupportedNodeIndicator(value: string): void {
  if (!UNSUPPORTED_NODE_PREFIXES.has(value[0])) return;
  throw new FrontmatterError(`Unsupported YAML anchor, alias, or tag: ${value.slice(0, 40)}`);
}

const DOUBLE_QUOTED_ESCAPE = '\\';
const SINGLE_QUOTE_ESCAPE = "''";

type QuotedScalar = { kind: 'value'; value: string } | { kind: 'error'; message: string };

/**
 * Read a quoted scalar. Only the simple quoted forms this subset can preserve
 * are accepted: escapes and doubled single quotes are rejected rather than
 * decoded incorrectly, and trailing content may only be a comment.
 */
function readQuotedScalar(raw: string): QuotedScalar | null {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = raw.indexOf(quote, 1);
  if (end === -1) {
    return { kind: 'error', message: `Unterminated quoted string: ${raw.slice(0, 40)}` };
  }
  const value = raw.slice(1, end);
  if (quote === '"' && value.includes(DOUBLE_QUOTED_ESCAPE)) {
    return {
      kind: 'error',
      message: `Escaped characters are not supported: ${raw.slice(0, 40)}`,
    };
  }
  if (quote === "'" && value.includes(SINGLE_QUOTE_ESCAPE)) {
    return {
      kind: 'error',
      message: `Escaped single quotes are not supported: ${raw.slice(0, 40)}`,
    };
  }
  const trailing = raw.slice(end + 1).trim();
  if (trailing !== '' && !trailing.startsWith('#')) {
    return {
      kind: 'error',
      message: `Unexpected trailing content after a quoted string: ${raw.slice(0, 40)}`,
    };
  }
  return { kind: 'value', value };
}

/** Remove an inline YAML comment from an unquoted scalar (a `#` after whitespace). */
function stripInlineComment(raw: string): string {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '#') continue;
    if (index === 0 || /\s/.test(raw[index - 1])) return raw.slice(0, index);
  }
  return raw;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const quoted = readQuotedScalar(trimmed);
  if (quoted) {
    if (quoted.kind === 'error') throw new FrontmatterError(quoted.message);
    return quoted.value;
  }

  const value = stripInlineComment(trimmed).trim();
  if (value === '') return null;
  rejectUnsupportedNodeIndicator(value);
  if (UNSUPPORTED_VALUE_PREFIXES.has(value[0])) {
    throw new FrontmatterError(`Unsupported YAML value: ${value.slice(0, 40)}`);
  }
  if (value === '~' || value === 'null' || value === 'Null') return null;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  if (/^-?\d+$/.test(value) || /^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

/** Find the key/value separator, ignoring colons inside quoted keys. */
function findKeySeparator(text: string): number {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':') return index;
  }
  return -1;
}

function decodeKey(rawKey: string): string {
  const quoted = readQuotedScalar(rawKey);
  if (quoted) {
    if (quoted.kind === 'error') throw new FrontmatterError(quoted.message);
    return quoted.value;
  }
  if (rawKey.includes('"') || rawKey.includes("'") || rawKey.includes('#')) {
    throw new FrontmatterError(`Unsupported YAML key: ${rawKey.slice(0, 40)}`);
  }
  rejectUnsupportedNodeIndicator(rawKey);
  return rawKey;
}

function splitKeyValue(text: string): { key: string; rest: string } {
  if (text === '-' || text.startsWith('- ')) {
    throw new FrontmatterError('List values are not supported in frontmatter');
  }
  const index = findKeySeparator(text);
  if (index <= 0) {
    throw new FrontmatterError(`Expected "key: value", found: ${text.slice(0, 60)}`);
  }
  const rawKey = text.slice(0, index).trim();
  if (rawKey.length === 0) {
    throw new FrontmatterError(`Expected "key: value", found: ${text.slice(0, 60)}`);
  }
  return { key: decodeKey(rawKey), rest: text.slice(index + 1).trim() };
}

function parseMap(
  lines: SourceLine[],
  start: number,
  indent: number
): [Record<string, unknown>, number] {
  const result = Object.create(null) as Record<string, unknown>;
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new FrontmatterError('Unexpected indentation in frontmatter');
    }
    const { key, rest } = splitKeyValue(line.text);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new FrontmatterError(`Duplicate key "${key}" in frontmatter`);
    }
    index += 1;
    if (rest !== '') {
      result[key] = parseScalar(rest);
      continue;
    }
    if (index < lines.length && lines[index].indent > indent) {
      const [nested, next] = parseMap(lines, index, lines[index].indent);
      result[key] = nested;
      index = next;
      continue;
    }
    result[key] = null;
  }
  return [result, index];
}

export function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1) return { status: 'none' };

  const opener = normalized.slice(0, firstLineEnd).trimEnd();
  if (opener !== '---' && opener !== '+++') return { status: 'none' };

  let lineStart = firstLineEnd + 1;
  let blockEnd: number | null = null;
  let bodyStart: number | null = null;
  while (lineStart <= normalized.length) {
    const lineEnd = normalized.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? normalized.length : lineEnd;
    if (normalized.slice(lineStart, end).trimEnd() === opener) {
      blockEnd = lineStart;
      bodyStart = lineEnd === -1 ? normalized.length : lineEnd + 1;
      break;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  if (blockEnd === null || bodyStart === null) {
    return { status: 'error', message: 'Frontmatter is not terminated' };
  }

  const body = normalized.slice(bodyStart);
  const block = normalized.slice(firstLineEnd + 1, blockEnd);

  try {
    const lines = splitIndentedLines(block);
    if (lines.length === 0) return { status: 'ok', data: {}, body };
    if (lines[0].indent !== 0) {
      throw new FrontmatterError('Unexpected indentation in frontmatter');
    }
    const [data, next] = parseMap(lines, 0, 0);
    if (next !== lines.length) {
      throw new FrontmatterError('Unexpected indentation in frontmatter');
    }
    return { status: 'ok', data, body };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof FrontmatterError ? error.message : 'Invalid frontmatter',
    };
  }
}
