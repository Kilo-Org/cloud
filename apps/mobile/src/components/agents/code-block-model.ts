import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';

/**
 * Resolve a markdown fence info string to the language name used by the
 * highlighter, or `null` for no language. Only the first word counts
 * (`'TS extra'` → `'ts'`); alias resolution is left to lowlight, and unknown
 * names fall back to plain text inside `highlightLine`. `undefined`, empty,
 * and whitespace-only info strings all return `null`.
 */
export function normalizeFenceLanguage(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const first = raw.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/**
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}
