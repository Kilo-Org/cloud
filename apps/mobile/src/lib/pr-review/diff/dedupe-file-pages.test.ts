import { describe, expect, it } from 'vitest';

import { dedupeFilesByPath, flattenFilePages } from './dedupe-file-pages';

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

describe('flattenFilePages', () => {
  it('returns [] for undefined pages', () => {
    expect(flattenFilePages(undefined)).toEqual([]);
  });

  it('returns [] for empty pages array', () => {
    expect(flattenFilePages([])).toEqual([]);
  });

  it('concatenates non-overlapping pages in page order', () => {
    const pages = [{ files: [{ path: 'a.ts' }, { path: 'b.ts' }] }, { files: [{ path: 'c.ts' }] }];
    expect(flattenFilePages(pages)).toEqual([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
  });

  it('dedupes a path repeated across page boundaries, keeping first occurrence', () => {
    const first = { path: 'a.ts', page: 1 };
    const second = { path: 'a.ts', page: 2 };
    const pages = [{ files: [first] }, { files: [second] }];
    expect(flattenFilePages(pages)).toEqual([first]);
  });

  it('works with a single page', () => {
    const pages = [{ files: [{ path: 'x.ts' }, { path: 'y.ts' }] }];
    expect(flattenFilePages(pages)).toEqual([{ path: 'x.ts' }, { path: 'y.ts' }]);
  });

  it('dedupes within and across pages', () => {
    const pages = [
      {
        files: [
          { path: 'a.ts', n: 1 },
          { path: 'b.ts', n: 1 },
        ],
      },
      {
        files: [
          { path: 'a.ts', n: 2 },
          { path: 'c.ts', n: 2 },
        ],
      },
      {
        files: [
          { path: 'b.ts', n: 3 },
          { path: 'd.ts', n: 3 },
        ],
      },
    ];
    expect(flattenFilePages(pages)).toEqual([
      { path: 'a.ts', n: 1 },
      { path: 'b.ts', n: 1 },
      { path: 'c.ts', n: 2 },
      { path: 'd.ts', n: 3 },
    ]);
  });
});
