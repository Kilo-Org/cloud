// Guard against duplicate ids when flattening infinite-query pages.
// First occurrence wins so clean server data is unchanged; cross-page
// duplicates (retry/refetch races) cannot produce duplicate list keys.

export function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}
