import { MarkedLexer, type Token } from 'react-native-marked';

/**
 * Every lexer call site lexes with `{ gfm: true }`, so a value fully identifies
 * its token list and one cache can serve the HTML splitter, the table
 * extractor, and the element parser.
 *
 * The cache is bounded by the total characters of the values it holds, not by
 * entry count: one pasted 200 KB fenced block costs far more to lex than a
 * hundred short messages, and the transcript scroll window is the unit that
 * matters. The least recently used value is evicted first, so the messages in
 * view keep their parse while off-screen ones are dropped.
 */
const MARKDOWN_PARSE_CACHE_CHARACTER_BUDGET = 512_000;
const MARKDOWN_RESULT_CACHE_CHARACTER_BUDGET = 512_000;

type MarkdownCacheEntry<T> = {
  value: T;
  characters: number;
};

/**
 * A tiny LRU keyed by the markdown source, evicted once the keys it holds
 * exceed a character budget. A read refreshes an entry's recency, so the cache
 * evicts the value not touched for the longest instead of the oldest insert.
 */
class MarkdownValueCache<T> {
  private readonly entries = new Map<string, MarkdownCacheEntry<T>>();
  private readonly budget: number;
  private characters = 0;

  constructor(budget: number) {
    this.budget = budget;
    registeredCaches.add(this);
  }

  get(value: string): T | undefined {
    const entry = this.entries.get(value);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(value);
    this.entries.set(value, entry);
    return entry.value;
  }

  set(value: string, result: T): T {
    const existing = this.entries.get(value);
    if (existing !== undefined) {
      this.characters -= existing.characters;
      this.entries.delete(value);
    }
    this.entries.set(value, { value: result, characters: value.length });
    this.characters += value.length;
    this.evictToBudget();
    return result;
  }

  clear(): void {
    this.entries.clear();
    this.characters = 0;
  }

  private evictToBudget(): void {
    while (this.characters > this.budget && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry !== undefined) {
        this.characters -= entry.characters;
      }
    }
  }
}

type ClearableCache = { clear: () => void };
const registeredCaches = new Set<ClearableCache>();

const lexedMarkdownCache = new MarkdownValueCache<Token[]>(MARKDOWN_PARSE_CACHE_CHARACTER_BUDGET);

/**
 * The lexed tokens of `value`, lexed once and reused by later mounts of an
 * unchanged value. Callers must treat the returned tokens as immutable: the
 * cache hands the same array to every consumer of `value`.
 */
export function getLexedMarkdown(value: string): Token[] {
  const cached = lexedMarkdownCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
  return lexedMarkdownCache.set(value, tokens);
}

/**
 * Build a per-value cache for one derived parse result (a segmentation, not the
 * tokens). The returned function memoizes `build` by the source value and skips
 * it on a hit; a result whose computation also depends on a previous snapshot
 * must be keyed by hand and only routed here for the fresh-value path.
 */
export function createMarkdownResultCache<T>(): (value: string, build: () => T) => T {
  const cache = new MarkdownValueCache<T>(MARKDOWN_RESULT_CACHE_CHARACTER_BUDGET);
  return (value, build) => {
    const cached = cache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    return cache.set(value, build());
  };
}

/**
 * Test-only: drop every cached token list and parse result so a suite can count
 * lexer calls from a known empty state.
 */
export function clearMarkdownParseCache(): void {
  for (const cache of registeredCaches) {
    cache.clear();
  }
}
