// Pure file-level types and constants for the PR review diff viewer. Lives
// in a module with no React / react-query imports so it can be tested in
// plain Node.

import {
  type ProviderPrFilePatchMissingCause,
  providerPrFileStatus,
  type ProviderPrFileStatus,
} from '@kilocode/app-shared/provider-review';

export type PrReviewFile = {
  path: string;
  previousPath: string | null;
  status: ProviderPrFileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  patchMissingCause: ProviderPrFilePatchMissingCause | null;
};

/**
 * Normalize one file read into the row shape. Reads cross a deployment skew
 * here, at the one boundary every page passes through.
 *
 * `patchMissingCause` arrives in three shapes. A current server names why a
 * file has no patch, or sends an explicit `null` for a read that carried one
 * (which the rows still answer as "no preview" when it holds no hunks). A
 * server older than the field sends neither: it set `patchMissing` from
 * `!patch`, so a null patch there has no cause to name. Resolving that absent
 * cause from the patch keeps the row honest — a patch-less file stays
 * non-expandable and prints its sentence instead of offering an expand control
 * that opens nothing, while a file with a patch keeps its hunks.
 *
 * `status` crosses the same boundary: an older deployment sends a raw provider
 * word (`deleted`), and the closed status record has no entry for it, so the
 * row would render an undefined icon. Mapping it through the contract's own
 * normalizer keeps a pre-PR server readable at every row.
 */
export function normalizePrReviewFile<T extends PrReviewFileRead>(
  file: T
): Omit<T, 'status' | 'patchMissingCause'> & {
  status: ProviderPrFileStatus;
  patchMissingCause: ProviderPrFilePatchMissingCause | null;
} {
  return {
    ...file,
    status: providerPrFileStatus(file.status),
    patchMissingCause: patchMissingCauseOf(file),
  };
}

/**
 * One file read as a deployment older than `patchMissingCause` sends it: the
 * key is absent, so the row type's required cause cannot describe it.
 */
export type PrReviewFileRead = Omit<PrReviewFile, 'patchMissingCause'> & {
  patchMissingCause?: ProviderPrFilePatchMissingCause | null;
};

function patchMissingCauseOf(file: PrReviewFileRead): ProviderPrFilePatchMissingCause | null {
  if (file.patchMissingCause !== undefined) {
    return file.patchMissingCause;
  }
  return file.patch === null ? 'provider_omitted' : null;
}

export const PR_REVIEW_MAX_LISTED_FILES = 3000;

// Server caps cursor at 60 (per the S2 read DTO contract). Pages after
// 60 are silently dropped; this is the same boundary the server uses
// for "no more pages" detection, so the client never asks for page 61.
export const PR_REVIEW_MAX_PAGES = 60;
