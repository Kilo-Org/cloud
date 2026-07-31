import { describe, expect, it } from 'vitest';

import {
  selectAwaitingCommit,
  selectEffectiveSearchQuery,
  selectShowSearchBusy,
} from '@/components/agents/session-list-search-busy';

describe('selectAwaitingCommit', () => {
  it('returns true when hasText and lastTyped trimmed differs from committed query', () => {
    expect(selectAwaitingCommit({ hasText: true, lastTyped: 'hello', searchQuery: '' })).toBe(true);
  });

  it('returns false when hasText is false (empty input)', () => {
    expect(selectAwaitingCommit({ hasText: false, lastTyped: '', searchQuery: 'committed' })).toBe(
      false
    );
  });

  it('returns false when lastTyped trimmed equals committed query (query committed)', () => {
    expect(
      selectAwaitingCommit({ hasText: true, lastTyped: 'committed', searchQuery: 'committed' })
    ).toBe(false);
  });

  it('returns false when lastTyped is only trailing whitespace (committed trimmed value)', () => {
    // trim mirrors the controller's text.trim() — trailing spaces do not stick
    expect(selectAwaitingCommit({ hasText: true, lastTyped: '  ', searchQuery: '' })).toBe(false);
  });

  it('returns true when lastTyped has content but no committed query', () => {
    expect(selectAwaitingCommit({ hasText: true, lastTyped: 'a', searchQuery: '' })).toBe(true);
  });

  it('returns false when both lastTyped and searchQuery are empty', () => {
    expect(selectAwaitingCommit({ hasText: false, lastTyped: '', searchQuery: '' })).toBe(false);
  });
});

describe('selectShowSearchBusy', () => {
  it('returns true during the debounce window (awaitingCommit true)', () => {
    // Scenario: user typed "hel" but the debounced query hasn't committed yet
    expect(
      selectShowSearchBusy({ awaitingCommit: true, isSearching: false, isFetching: false })
    ).toBe(true);
  });

  it('returns true during the first fetch (isSearching, isPending true, isFetching true)', () => {
    // keepPreviousData has no previous data — isPending + isFetching
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: true, isFetching: true })
    ).toBe(true);
  });

  it('returns true during a refinement fetch with previous data (isFetching, !isPending)', () => {
    // keepPreviousData has stale results — isPending false, isFetching true
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: true, isFetching: true })
    ).toBe(true);
  });

  it('returns false when search is idle (not searching)', () => {
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: false, isFetching: false })
    ).toBe(false);
  });

  it('returns false on clear-X (not searching, no awaitingCommit)', () => {
    // On clear, searchQuery becomes '' immediately — isSearching false,
    // no fetch triggered, awaitingCommit false.
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: false, isFetching: false })
    ).toBe(false);
  });

  it('returns true during same-key refetch/retry (isFetching without isPending)', () => {
    // isPlaceholderData is false here — still covers it via isFetching
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: true, isFetching: true })
    ).toBe(true);
  });

  it('returns true when both awaitingCommit and isFetching are true (edge: commit lands mid-debounce)', () => {
    expect(
      selectShowSearchBusy({ awaitingCommit: true, isSearching: true, isFetching: true })
    ).toBe(true);
  });
});

describe('selectEffectiveSearchQuery', () => {
  it('returns empty string on first fetch (isSearching + isPending → gate blanks the body)', () => {
    expect(
      selectEffectiveSearchQuery({ isSearching: true, isPending: true, searchQuery: 'test' })
    ).toBe('');
  });

  it('returns the committed query during refinement (isSearching + !isPending → keep stale results)', () => {
    // keepPreviousData has previous results — the body keeps showing them
    expect(
      selectEffectiveSearchQuery({ isSearching: true, isPending: false, searchQuery: 'refined' })
    ).toBe('refined');
  });

  it('returns the committed query when not searching', () => {
    expect(
      selectEffectiveSearchQuery({ isSearching: false, isPending: false, searchQuery: '' })
    ).toBe('');
  });

  it('returns empty string when isPending and isSearching even if searchQuery has value', () => {
    // Gate keeps the body from showing results for a mismatched query during first fetch
    expect(
      selectEffectiveSearchQuery({ isSearching: true, isPending: true, searchQuery: 'anything' })
    ).toBe('');
  });
});
