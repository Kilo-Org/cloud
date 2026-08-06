/**
 * Per-line syntax highlighting for workflow scripts.
 *
 * The accepted ceiling is per-line highlighting: every diff line is
 * highlighted independently. A template literal or a block comment that spans
 * lines mis-colors after its first line because the highlighter does not know
 * the token is still open. This is the same trade-off the mobile PR-review
 * surface accepts (apps/mobile/src/lib/pr-review/diff/highlight.ts) and it is
 * the right size for a workflow script, which is always JavaScript. No
 * highlighter dependency: five token classes and one ordered regex cover it.
 */
export type ScriptToken = 'comment' | 'string' | 'keyword' | 'number' | 'plain';
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type ScriptSpan = { text: string; token: ScriptToken };

// The keyword set the workflow script contract actually uses.
const KEYWORDS = [
  'await',
  'async',
  'const',
  'let',
  'var',
  'if',
  'else',
  'for',
  'of',
  'in',
  'return',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'new',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'while',
  'do',
  'break',
  'continue',
];

/**
 * One ordered regex scanned once per line. The alternation order is the
 * priority: comments first, then strings (each honouring `\.` escapes and
 * running to the end of the line when the closing quote is missing), then
 * numbers, then keywords on word boundaries. Everything else stays plain.
 */
const TOKEN_PATTERN = new RegExp(
  [
    `(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/|/\\*[\\s\\S]*$)`,
    `(?<string>'(?:\\\\.|[^'\\n])*'?|"(?:\\\\.|[^"\\n])*"?|\`(?:\\\\.|[^\`\\n])*\`?)`,
    `(?<number>\\b\\d+(?:\\.\\d+)?\\b)`,
    `(?<keyword>\\b(?:${KEYWORDS.join('|')})\\b)`,
  ].join('|'),
  'g'
);

const tokenForMatch = (match: RegExpMatchArray): ScriptToken => {
  const { groups } = match;
  if (groups?.['comment'] !== undefined) {
    return 'comment';
  }
  if (groups?.['string'] !== undefined) {
    return 'string';
  }
  if (groups?.['number'] !== undefined) {
    return 'number';
  }
  return 'keyword';
};

/**
 * Merge adjacent plain spans so the renderer emits few nodes. With the current
 * pattern plain runs are already separated by token matches, but keeping the
 * merge here protects the one-span-per-run contract if the pattern ever grows
 * a zero-width alternative.
 */
const pushSpan = (spans: ScriptSpan[], span: ScriptSpan): void => {
  const previous = spans.at(-1);
  if (previous !== undefined && previous.token === 'plain' && span.token === 'plain') {
    previous.text += span.text;
    return;
  }
  spans.push(span);
};

export const highlightScriptLine = (line: string): ScriptSpan[] => {
  const spans: ScriptSpan[] = [];
  let cursor = 0;
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    const text = match[0] ?? '';
    if (index > cursor) {
      pushSpan(spans, { text: line.slice(cursor, index), token: 'plain' });
    }
    pushSpan(spans, { text, token: tokenForMatch(match) });
    cursor = index + text.length;
  }
  if (cursor < line.length) {
    pushSpan(spans, { text: line.slice(cursor), token: 'plain' });
  }
  return spans;
};
