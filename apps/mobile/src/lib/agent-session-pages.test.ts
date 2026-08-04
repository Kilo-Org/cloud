import { describe, expect, it } from 'vitest';

import {
  collectSearchPages,
  collectUnfilteredPages,
  dedupeBySessionId,
  shouldLoadMoreSessions,
} from '@/lib/agent-session-pages';

const s = (session_id: string) => ({ session_id });

describe('dedupeBySessionId', () => {
  it('returns an empty array for an empty input', () => {
    expect(dedupeBySessionId([])).toEqual([]);
  });

  it('returns the same array when no duplicates exist', () => {
    const sessions = [s('a'), s('b'), s('c')];
    expect(dedupeBySessionId(sessions)).toEqual(sessions);
  });

  it('keeps the first occurrence and drops later duplicates', () => {
    const sessions = [s('a'), s('b'), s('a'), s('c'), s('b')];
    expect(dedupeBySessionId(sessions)).toEqual([s('a'), s('b'), s('c')]);
  });

  it('does not mutate the input array', () => {
    const sessions = [s('a'), s('a')];
    const copy = [...sessions];
    dedupeBySessionId(sessions);
    expect(sessions).toEqual(copy);
  });
});

describe('collectUnfilteredPages', () => {
  it('returns an empty array for undefined pages', () => {
    expect(collectUnfilteredPages(undefined)).toEqual([]);
  });

  it('returns an empty array for zero pages', () => {
    expect(collectUnfilteredPages([])).toEqual([]);
  });

  it('flattens cliSessions across pages and preserves order', () => {
    const pages = [{ cliSessions: [s('a'), s('b')] }, { cliSessions: [s('c'), s('d')] }];
    expect(collectUnfilteredPages(pages)).toEqual([s('a'), s('b'), s('c'), s('d')]);
  });

  it('dedupes repeat sessions across pages, keeping the first', () => {
    const pages = [{ cliSessions: [s('a'), s('b')] }, { cliSessions: [s('c'), s('a'), s('d')] }];
    expect(collectUnfilteredPages(pages)).toEqual([s('a'), s('b'), s('c'), s('d')]);
  });
});

describe('collectSearchPages', () => {
  it('returns an empty array for undefined pages', () => {
    expect(collectSearchPages(undefined)).toEqual([]);
  });

  it('returns an empty array for zero pages', () => {
    expect(collectSearchPages([])).toEqual([]);
  });

  it('flattens results across pages and preserves order', () => {
    const pages = [{ results: [s('x'), s('y')] }, { results: [s('z')] }];
    expect(collectSearchPages(pages)).toEqual([s('x'), s('y'), s('z')]);
  });

  it('dedupes repeat results across pages, keeping the first', () => {
    const pages = [{ results: [s('x'), s('y')] }, { results: [s('z'), s('x')] }];
    expect(collectSearchPages(pages)).toEqual([s('x'), s('y'), s('z')]);
  });
});

describe('shouldLoadMoreSessions', () => {
  it('returns true when hasNextPage is true and no gate blocks (favorable path)', () => {
    expect(
      shouldLoadMoreSessions({
        hasNextPage: true,
        isFetchingNextPage: false,
        isPlaceholderData: false,
      })
    ).toBe(true);
  });

  it('returns false when hasNextPage is false (no more pages)', () => {
    expect(
      shouldLoadMoreSessions({
        hasNextPage: false,
        isFetchingNextPage: false,
        isPlaceholderData: false,
      })
    ).toBe(false);
  });

  it('returns false when isFetchingNextPage is true (already fetching)', () => {
    expect(
      shouldLoadMoreSessions({
        hasNextPage: true,
        isFetchingNextPage: true,
        isPlaceholderData: false,
      })
    ).toBe(false);
  });

  it('returns false when isPlaceholderData is true (wrong-query paging blocked)', () => {
    expect(
      shouldLoadMoreSessions({
        hasNextPage: true,
        isFetchingNextPage: false,
        isPlaceholderData: true,
      })
    ).toBe(false);
  });

  it('returns false when hasNextPage is undefined (not yet loaded)', () => {
    expect(
      shouldLoadMoreSessions({
        hasNextPage: undefined,
        isFetchingNextPage: false,
        isPlaceholderData: false,
      })
    ).toBe(false);
  });
});
