// Guard against duplicate file paths when flattening infinite-query pages.
// First occurrence wins so clean server data is unchanged; cross-page
// duplicates (retry/refetch races) cannot produce duplicate list keys.

export function dedupeFilesByPath<T extends { readonly path: string }>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      result.push(file);
    }
  }
  return result;
}
