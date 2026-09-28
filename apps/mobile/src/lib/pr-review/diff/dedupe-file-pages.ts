// Guard against duplicate file paths when flattening infinite-query pages.
// First occurrence wins so clean server data is unchanged; cross-page
// duplicates (retry/refetch races) cannot produce duplicate list keys.

import { dedupeBy } from '@/lib/query/dedupe-by-id';

export function dedupeFilesByPath<T extends { readonly path: string }>(files: readonly T[]): T[] {
  return dedupeBy(files, file => file.path);
}

/** Flatten infinite-query pages into a single deduped file list (first occurrence wins). */
export function flattenFilePages<T extends { readonly path: string }>(
  pages: readonly { readonly files: readonly T[] }[] | undefined
): T[] {
  const all: T[] = [];
  for (const page of pages ?? []) {
    for (const file of page.files) {
      all.push(file);
    }
  }
  return dedupeFilesByPath(all);
}
