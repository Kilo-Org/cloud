import { describe, expect, it } from 'vitest';

import { normalizePrReviewFile, type PrReviewFile } from './pr-review-file-types';

const file = {
  path: 'src/a.ts',
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-a\n+b\n',
  patchMissingCause: null,
} satisfies PrReviewFile;

describe('normalizePrReviewFile', () => {
  it('keeps a file that carries its cause unchanged', () => {
    expect(normalizePrReviewFile(file).patchMissingCause).toBeNull();
  });

  it.each(['binary', 'too_large', 'provider_omitted', 'content_unchanged'] as const)(
    'keeps the %s cause',
    cause => {
      expect(normalizePrReviewFile({ ...file, patchMissingCause: cause }).patchMissingCause).toBe(
        cause
      );
    }
  );

  it('folds an absent cause to null', () => {
    // A web deployment that predates the field sends no key at all. The rows
    // test `=== null`, so `undefined` would read as patch-missing and hide the
    // hunks of every file; the boundary folds it to the "has a patch" value.
    const { patchMissingCause: _omitted, ...older } = file;
    expect(normalizePrReviewFile(older as PrReviewFile).patchMissingCause).toBeNull();
  });
});
