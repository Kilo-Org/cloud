/**
 * Splits a list into batches of at most `size` items, for bulk writes.
 *
 * An empty list gives `null`, not `[]`: callers use `null` to skip the write.
 */
export function toBatches<T>(items: readonly T[], size: number): T[][] | null {
  if (items.length === 0) {
    return null;
  }
  const batches: T[][] = [];
  for (let start = 0; start <= items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** The number of batches that `toBatches` makes. */
export function batchCount(total: number, size: number): number {
  return Math.floor(total / size);
}
