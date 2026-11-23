import { describe, expect, it } from 'vitest';

import { type ProviderPrFileStatus } from '@kilocode/app-shared/provider-review';

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

  it('keeps an absent cause on a file with a patch as no cause', () => {
    // A deployment that predates the field sends no key at all; with a patch it
    // also sent `patchMissing: false`, so the row has its hunks and no cause.
    const { patchMissingCause: _omitted, ...older } = file;
    expect(normalizePrReviewFile(older).patchMissingCause).toBeNull();
  });

  it('reads an absent cause on a patch-less file as the provider omitting the diff', () => {
    // That same deployment set `patchMissing` from `!patch`, so this file was
    // patch-missing there too. Leaving the cause unset would make the row
    // expandable over nothing; naming the omission keeps its sentence.
    const { patchMissingCause: _omitted, ...older } = file;
    expect(normalizePrReviewFile({ ...older, patch: null }).patchMissingCause).toBe(
      'provider_omitted'
    );
  });

  it('keeps an explicit null cause on a patch-less file as no cause', () => {
    // A current server sends the explicit null for a read that carried a patch
    // which parsed to zero hunks, which the rows answer as "no preview".
    expect(normalizePrReviewFile({ ...file, patch: null }).patchMissingCause).toBeNull();
  });

  it('maps a pre-PR provider word into the closed status set', () => {
    // An older web deployment sends GitLab's raw `deleted`; the closed status
    // record has no icon for it, so an unnormalized word paints undefined.
    const older = { ...file, status: 'deleted' as ProviderPrFileStatus };
    expect(normalizePrReviewFile(older).status).toBe('removed');
  });

  it('keeps every status the contract allows', () => {
    for (const status of [
      'added',
      'removed',
      'modified',
      'renamed',
      'copied',
      'changed',
    ] as const) {
      expect(normalizePrReviewFile({ ...file, status }).status).toBe(status);
    }
  });
});
