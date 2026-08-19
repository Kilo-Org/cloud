// Pure file-filter helpers for the PR file navigator. Extracted from
// `pr-diff-file-navigator.tsx` so the filter and the "load all" decision
// are testable without mounting the sheet.

import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

/** Case-insensitive substring filter over file paths. An empty query returns the input unchanged. */
export function filterNavigatorFiles(files: PrReviewFile[], query: string): PrReviewFile[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return files;
  }
  return files.filter(file => file.path.toLowerCase().includes(needle));
}

/** True when a search is active, so the navigator must load the full listed set. */
export function shouldLoadAllFiles(query: string): boolean {
  return query.trim().length > 0;
}
