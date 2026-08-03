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
  it('returns true during the debounce window (typed text not yet committed)', () => {
    expect(
      selectShowSearchBusy({ awaitingCommit: true, isSearching: false, isFetching: false })
    ).toBe(true);
  });

  it('returns true while fetching or refetching (isSearching and isFetching)', () => {
    // Covers first fetch, refinement under keepPreviousData, same-key retry:
    // the selector only sees awaitingCommit, isSearching, isFetching.
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: true, isFetching: true })
    ).toBe(true);
  });

  it('returns false when search is idle (no awaiting commit, not searching)', () => {
    expect(
      selectShowSearchBusy({ awaitingCommit: false, isSearching: false, isFetching: false })
    ).toBe(false);
  });

  it('returns true when both awaitingCommit and isFetching are true (mid-debounce edge)', () => {
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
