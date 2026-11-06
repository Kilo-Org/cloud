import { marked, type TokensList } from 'marked';

import { CharacterBoundedCache } from './character-bounded-cache';
import { type MarkdownHtmlSplit } from './markdown-html';

// Two megabytes of source text per artifact kind. A 200-message transcript of
// ordinary sizes fits entirely; a transcript of huge messages keeps only the
// most recent values, which are the ones a scroll is about to remount.
const MARKDOWN_PARSE_CACHE_CHARACTERS = 2_000_000;

const markdownTokenCache = new CharacterBoundedCache<TokensList>(MARKDOWN_PARSE_CACHE_CHARACTERS);
export const markdownHtmlSplitCache = new CharacterBoundedCache<MarkdownHtmlSplit>(
  MARKDOWN_PARSE_CACHE_CHARACTERS
);

/**
 * `marked.lexer(value, { gfm: true })`, memoized by value. Lexing is pure and
 * context-free, so a token list can be shared across every caller that segments
 * the same source; a remount of a completed value reuses the tokens instead of
 * walking the whole value again. Streaming appends lex only their suffix, and
 * the bounded cache evicts the intermediate prefixes.
 */
export function lexMarkdown(value: string): TokensList {
  const cached = markdownTokenCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const tokens = marked.lexer(value, { gfm: true });
  markdownTokenCache.set(value, tokens);
  return tokens;
}

/**
 * For tests: drop every module-level parse artifact so a suite starts cold. The
 * caches are warm for the life of a process, so without this a suite that spies
 * on or counts lexer calls sees a value another test already cached and observes
 * zero calls instead of the one its own mount performed.
 */
export function clearMarkdownParseCachesForTests(): void {
  markdownTokenCache.clear();
  markdownHtmlSplitCache.clear();
}
