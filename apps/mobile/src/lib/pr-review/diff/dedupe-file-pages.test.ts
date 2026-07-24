import { describe, expect, it } from 'vitest';

import { dedupeFilesByPath } from './dedupe-file-pages';

describe('dedupeFilesByPath', () => {
  it('returns the same order when there are no duplicates', () => {
    const files = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }];
    expect(dedupeFilesByPath(files)).toEqual(files);
  });

  it('keeps the first occurrence when the same path appears twice', () => {
    const first = { path: 'a.ts', page: 1 };
    const second = { path: 'a.ts', page: 2 };
    expect(dedupeFilesByPath([first, second])).toEqual([first]);
  });

  it('dedupes across page-like sequences while preserving first-seen order', () => {
    const files = [
      { path: 'a.ts', n: 1 },
      { path: 'b.ts', n: 1 },
      { path: 'a.ts', n: 2 },
      { path: 'c.ts', n: 2 },
      { path: 'b.ts', n: 2 },
      { path: 'd.ts', n: 3 },
    ];
    expect(dedupeFilesByPath(files)).toEqual([
      { path: 'a.ts', n: 1 },
      { path: 'b.ts', n: 1 },
      { path: 'c.ts', n: 2 },
      { path: 'd.ts', n: 3 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeFilesByPath([])).toEqual([]);
  });
});
