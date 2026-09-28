import { describe, expect, it } from 'vitest';

import { dedupeBy, dedupeById } from './dedupe-by-id';

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

describe('dedupeBy', () => {
  it('dedupes by a non-id key, keeping the first occurrence without mutating the input', () => {
    const first = { path: 'a.ts', page: 1 };
    const second = { path: 'b.ts', page: 1 };
    const duplicate = { path: 'a.ts', page: 2 };
    const items = [first, second, duplicate];
    const snapshot = [...items];

    const result = dedupeBy(items, item => item.path);

    expect(result).toEqual([first, second]);
    expect(items).toEqual(snapshot);
    expect(result[0]).toBe(first);
  });
});
