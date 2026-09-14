import { describe, expect, it } from 'vitest';

import { dedupeById } from './dedupe-by-id';

describe('dedupeById', () => {
  it('returns the same order when there are no duplicates', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(dedupeById(items)).toEqual(items);
  });

  it('keeps the first occurrence when the same id appears twice', () => {
    const first = { id: 'a', page: 1 };
    const second = { id: 'a', page: 2 };
    expect(dedupeById([first, second])).toEqual([first]);
  });

  it('dedupes across page-like sequences while preserving first-seen order', () => {
    const items = [
      { id: 'a', n: 1 },
      { id: 'b', n: 1 },
      { id: 'a', n: 2 },
      { id: 'c', n: 2 },
      { id: 'b', n: 2 },
      { id: 'd', n: 3 },
    ];
    expect(dedupeById(items)).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 1 },
      { id: 'c', n: 2 },
      { id: 'd', n: 3 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeById([])).toEqual([]);
  });
});
