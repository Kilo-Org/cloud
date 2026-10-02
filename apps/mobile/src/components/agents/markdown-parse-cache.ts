import { type ReactNode } from 'react';
import { type ColorSchemeName } from 'react-native';

import { MarkedLexer } from 'react-native-marked';

import { type MarkdownHtmlSplit } from './markdown-html';
import { type MarkdownPalette } from './markdown-palette';
import { type MarkdownRendererHandlers } from './markdown-renderer';
import { type MarkdownSplitSegment } from './markdown-table-extract';

/**
 * A module-level LRU keyed by a string, evicting the least-recently-used entries
 * once the total number of key characters exceeds `maxCharacters`.
 *
 * The markdown value is the cache key and its length is a close proxy for the
 * memory an entry costs, so one budget covers both the lexed tokens and the
 * React elements a value produced. Bounding the cache by characters — not by an
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

type MarkdownTokens = ReturnType<typeof MarkedLexer>;

const markdownTokenCache = new CharacterBoundedCache<MarkdownTokens>(
  MARKDOWN_PARSE_CACHE_CHARACTERS
);
export const markdownHtmlSplitCache = new CharacterBoundedCache<MarkdownHtmlSplit>(
  MARKDOWN_PARSE_CACHE_CHARACTERS
);
export const markdownTableSegmentsCache = new CharacterBoundedCache<MarkdownSplitSegment[]>(
  MARKDOWN_PARSE_CACHE_CHARACTERS
);
/**
 * A cached render of one markdown segment: its already-parsed React elements,
 * plus a way to point the renderer that built them at the host's current
 * interactive handlers.
 *
 * The elements embed callbacks the renderer captured while it built them.
 * A remount reuses those elements because the value did not change, but the
 * host may have re-rendered with new message-bound closures since (a reaction
 * or a delivery failure updates the message without touching its markdown). The
 * elements must dispatch through the renderer's current handlers, so a reused
 * fence long-press opens the current message's actions instead of the stale
 * ones. `bindHandlers` is that refresh; it is a no-op for handler-free callers.
 */
export type MarkdownRenderEntry = {
  elements: readonly ReactNode[];
  bindHandlers: (handlers: MarkdownRendererHandlers) => void;
};

export const markdownRenderCache = new CharacterBoundedCache<MarkdownRenderEntry>(
  MARKDOWN_PARSE_CACHE_CHARACTERS
);

/**
 * `MarkedLexer(value, { gfm: true })`, memoized by value. Lexing is pure and
 * context-free, so a token list can be shared across every caller that segments
 * the same source; a remount of a completed value reuses the tokens instead of
 * walking the whole value again. Streaming appends lex only their suffix, and
 * the bounded cache evicts the intermediate prefixes.
 */
export function lexMarkdown(value: string): MarkdownTokens {
  const cached = markdownTokenCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
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
  markdownTableSegmentsCache.clear();
  markdownRenderCache.clear();
}

export type MarkdownRenderKeyInput = {
  value: string;
  /**
   * A stable identity for the host that supplied the interactive handlers, e.g.
   * a message and session id. Two messages can carry byte-identical markdown,
   * and their cached elements would be indistinguishable without this: the
   * later message would reuse the earlier elements, whose `onLongPressCode`
   * closes over the earlier message, so a fence long-press would open the wrong
   * message. The scope is stable across a remount of the same message, so the
   * cache still serves the remount it exists for. `undefined` for static,
   * handler-free callers, which are safe to share.
   */
  renderScope?: string;
  palette: MarkdownPalette;
  selectable: boolean;
  colorScheme: ColorSchemeName;
  hasLongPressLink: boolean;
  hasPressLink: boolean;
  hasCopyCode: boolean;
  hasLongPressCode: boolean;
};

/**
 * The identity of a `MarkdownSegment` render. It carries the value, because the
 * renderer is rebuilt per value to keep element keys stable, plus every input
 * that changes the styles or the interactive affordances the elements captured.
 * Callback *identities* are deliberately absent: a remount rebuilds the
 * handlers, and keying on the function would miss every cache lookup a remount
 * makes. Their presence is part of the key, so gaining or losing an affordance
 * still re-parses. The `renderScope` stands in for the callback targets the
 * elements captured, so identical values in different messages never share.
 */
export function markdownRenderKey({
  value,
  renderScope,
  palette,
  selectable,
  colorScheme,
  hasLongPressLink,
  hasPressLink,
  hasCopyCode,
  hasLongPressCode,
}: MarkdownRenderKeyInput): string {
  return [
    value,
    renderScope ?? '',
    palette.textColor,
    palette.mutedTextColor,
    palette.codeBackground,
    palette.borderColor,
    palette.surfaceColor,
    palette.codeTokenScheme ?? '',
    selectable ? '1' : '0',
    colorScheme,
    hasLongPressLink ? '1' : '0',
    hasPressLink ? '1' : '0',
    hasCopyCode ? '1' : '0',
    hasLongPressCode ? '1' : '0',
  ].join('\u0000');
}
