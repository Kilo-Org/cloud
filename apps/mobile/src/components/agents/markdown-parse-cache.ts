import { marked, type TokensList } from 'marked';

import { type MarkdownHtmlSplit } from './markdown-html';

/**
 * A module-level LRU keyed by a string, evicting the least-recently-used entries
 * once the total number of key characters exceeds `maxCharacters`.
 *
 * The markdown value is the cache key and its length is a close proxy for the
 * memory an entry costs, so one budget covers both the lexed tokens and the
 * HTML split a value produced. Bounding the cache by characters — not by an
 * entry count — keeps a transcript of a few huge messages from pinning as much
 * as a transcript of thousands of tiny ones.
 */
class CharacterBoundedCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private totalWeight = 0;
  private readonly maxCharacters: number;

  constructor(maxCharacters: number) {
    this.maxCharacters = maxCharacters;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // Refresh recency: a Map iterates in insertion order, so re-inserting the
    // entry moves it to the most-recent end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.totalWeight -= existing.weight;
    }
    const weight = key.length;
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    this.evict();
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private evict(): void {
    // Keep the newest entry even when it alone outweighs the budget, the same
    // rule `evictFenceWalks` uses. The key is the whole markdown value, so at
    // 10x the audit's 256 KB message the key alone exceeds the budget; evicting
    // it the instant it was inserted made every `set` a no-op, so a remount
    // re-lexed and re-rendered the value the cache exists to keep. Retaining the
    // newest entry bounds the cache to one oversized value plus whatever fits
    // beside it while still serving the most recent remount.
    while (this.totalWeight > this.maxCharacters && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.totalWeight -= entry?.weight ?? 0;
    }
  }
}

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
