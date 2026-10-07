/**
 * Splits a list into batches of at most `size` items, for bulk writes.
 *
 * An empty list gives `null`, not `[]`: callers use `null` to skip the write.
 */
export function toBatches<T>(items: readonly T[], size: number): T[][] | null {
  if (size < 1) {
    throw new RangeError(`size must be at least 1, got ${size}`);
  }
  if (items.length === 0) {
    return null;
  }
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** The number of batches that `toBatches` makes. */
export function batchCount(total: number, size: number): number {
  if (size < 1) {
    throw new RangeError(`size must be at least 1, got ${size}`);
  }
  return Math.ceil(total / size);
}
