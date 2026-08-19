import { describe, expect, it } from 'vitest';

import { filterNavigatorFiles, shouldLoadAllFiles } from './navigator-file-filter';
import { type PrReviewFile } from './pr-review-file-types';

function makeFile(path: string): PrReviewFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch: null,
    patchMissing: false,
  };
}

describe('filterNavigatorFiles', () => {
  it('returns the input for an empty query', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    expect(filterNavigatorFiles(files, '')).toEqual(files);
  });

  it('matches case-insensitively by substring', () => {
    const files = [makeFile('src/App.tsx'), makeFile('src/util.ts')];
    expect(filterNavigatorFiles(files, 'APP')).toEqual([files[0]]);
  });

  it('returns [] when nothing matches', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    expect(filterNavigatorFiles(files, 'zzz')).toEqual([]);
  });
});

describe('shouldLoadAllFiles', () => {
  it('is false for an empty string', () => {
    expect(shouldLoadAllFiles('')).toBe(false);
  });

  it('is false for whitespace only', () => {
    expect(shouldLoadAllFiles('   ')).toBe(false);
  });

  it('is true for a real needle', () => {
    expect(shouldLoadAllFiles('src')).toBe(true);
  });
});
