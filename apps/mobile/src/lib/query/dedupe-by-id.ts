// Guard against duplicate ids when flattening infinite-query pages.
// First occurrence wins so clean server data is unchanged; cross-page
// duplicates (retry/refetch races) cannot produce duplicate list keys.

// eslint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- K names the dedupe key type in the public signature so a caller's key accessor stays documented at the call site
export function dedupeBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return dedupeBy(items, item => item.id);
}
